/* =========================================================
   vault.js
   Copia interna de tus datos en IndexedDB (otro almacén del
   navegador, distinto de localStorage).
   Sirve si localStorage se vacía o se daña por un fallo del
   navegador: al abrir, la app se recupera sola de esta copia.
   NO protege si borras los "datos del sitio" desde los ajustes
   del navegador (eso borra los dos almacenes). Para eso están
   los respaldos en PDF y Excel.
   Guarda la última versión y las 2 de días anteriores.
   Nunca lanza errores: si algo falla, simplemente no hay copia.
   Solo habla con IndexedDB; la validación la hace storage.js.
   ========================================================= */

const DB_NAME = 'finanzas-app-vault';
const STORE = 'snapshots';
const SLOTS = ['latest', 'prev1', 'prev2']; // de más nueva a más vieja
const MAX_JSON_LENGTH = 6 * 1024 * 1024;     // tope de seguridad (un poco más que el límite de respaldos)
const OPEN_TIMEOUT_MS = 3000;                // si IndexedDB no contesta, seguimos sin copia

/** ¿Este navegador tiene IndexedDB? */
function available() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Abre la base (la crea la primera vez). Devuelve null si no se pudo. */
function openVault() {
  if (!available()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'slot' });
      };
      request.onsuccess = () => done(request.result);
      request.onerror = () => done(null);
      request.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
}

/** Espera a que termine una transacción. Devuelve true si se completó bien. */
function finished(transaction) {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => resolve(false);
    transaction.onabort = () => resolve(false);
  });
}

/** Pide un registro. Devuelve el valor o null. */
function getRecord(store, slot) {
  return new Promise((resolve) => {
    try {
      const request = store.get(slot);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Guarda una copia (texto JSON ya validado por storage.js).
 * La copia de un día anterior se conserva: cuando cambia el día,
 * "latest" pasa a "prev1" y "prev1" a "prev2".
 * Devuelve true si se guardó.
 */
export async function vaultSave(json, day) {
  if (typeof json !== 'string' || json.length === 0 || json.length > MAX_JSON_LENGTH) return false;
  const db = await openVault();
  if (!db) return false;

  try {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const done = finished(transaction);

    const latest = await getRecord(store, 'latest');
    if (latest && latest.day && latest.day !== day) {
      // Empezó un día nuevo: se recorren las copias antes de escribir la nueva
      const prev1 = await getRecord(store, 'prev1');
      if (prev1) store.put({ ...prev1, slot: 'prev2' });
      store.put({ ...latest, slot: 'prev1' });
    }
    store.put({ slot: 'latest', json, day, savedAt: new Date().toISOString() });
    return await done;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Lee las copias que existan, de la más nueva a la más vieja: [{ slot, json, day, savedAt }]. */
export async function vaultRead() {
  const db = await openVault();
  if (!db) return [];

  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const found = [];
    for (const slot of SLOTS) {
      const record = await getRecord(store, slot);
      if (
        record &&
        typeof record.json === 'string' &&
        typeof record.savedAt === 'string'
      ) {
        found.push({ slot, json: record.json, day: String(record.day ?? ''), savedAt: record.savedAt });
      }
    }
    return found;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Borra todas las copias internas (se usa en "Borrar mis datos"). Devuelve true si quedó limpio. */
export async function vaultClear() {
  const db = await openVault();
  if (!db) return true; // sin IndexedDB no hay nada que borrar

  try {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).clear();
    return await finished(transaction);
  } catch {
    return false;
  } finally {
    db.close();
  }
}
