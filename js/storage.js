/* =========================================================
   storage.js
   ÚNICO archivo que lee y escribe en localStorage.
   Todo dato pasa por aquí y se valida antes de guardarse,
   tanto al agregarlo como al leerlo de nuevo.
   ========================================================= */

import {
  FREQUENCIES,
  addPeriods,
  cleanText,
  isPlainObject,
  isValidId,
  isValidISODate,
  newId,
  parseAmount,
  parsePercent,
  todayISO,
} from './utils.js';
import { vaultClear, vaultRead, vaultSave } from './vault.js';

const STORAGE_KEY = 'finanzas-app:data';
const CORRUPT_KEY = 'finanzas-app:data-corrupt';
const META_KEY = 'finanzas-app:meta';       // fechas de último respaldo, último cambio y avisos pospuestos
const CLEARED_KEY = 'finanzas-app:cleared'; // marca: la persona borró sus datos a propósito (no recuperar)
const MIRROR_DELAY_MS = 300;                // espera antes de actualizar la copia interna (agrupa cambios seguidos)
const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_VERSION = 1;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_PAYMENTS = 2000;

// Tipos de movimiento permitidos. Los tres últimos los crean los
// botones de "ya pagó" (préstamos) y "ya pagué" (deudas), para que el
// historial siga existiendo aunque una deuda se elimine al terminar.
export const TRANSACTION_TYPES = [
  'ingreso',
  'ahorro',
  'gasto',
  'retiro',
  'pago_deuda',
  'prestamo',       // dinero que le prestaste a alguien
  'cobro_interes',  // interés que te pagaron
  'cobro_prestamo', // capital que te devolvieron
];

// Movimientos donde la casilla "fromIncome" tiene sentido
const FROM_INCOME_TYPES = ['ahorro', 'pago_deuda', 'prestamo', 'cobro_interes', 'cobro_prestamo'];

/* =========================================================
   1. VALIDADORES: cada uno recibe un dato cualquiera y devuelve
      un objeto limpio, o null si algo no es válido.
   ========================================================= */

function sanitizePayments(list) {
  if (!Array.isArray(list)) return [];
  const result = [];
  for (const item of list.slice(0, MAX_PAYMENTS)) {
    if (!isPlainObject(item)) continue;
    const amount = parseAmount(item.amount);
    if (amount === null || !isValidISODate(item.date)) continue;
    // 'capital' = abono extra a capital; cualquier otra cosa = pago normal
    result.push({ date: item.date, amount, kind: item.kind === 'capital' ? 'capital' : 'regular' });
  }
  return result;
}

function sanitizeTransaction(raw) {
  if (!isPlainObject(raw)) return null;
  const amount = parseAmount(raw.amount);
  if (
    !isValidId(raw.id) ||
    !TRANSACTION_TYPES.includes(raw.type) ||
    !isValidISODate(raw.date) ||
    amount === null
  ) {
    return null;
  }
  return {
    id: raw.id,
    type: raw.type,
    date: raw.date,
    amount,
    note: cleanText(raw.note, 60),
    // true = ese movimiento cuenta en los ingresos (dinero disponible):
    //   ahorro, pago de deuda y préstamo dado -> se restan
    //   cobro de interés y de capital        -> se suman
    fromIncome: FROM_INCOME_TYPES.includes(raw.type) && raw.fromIncome === true,
  };
}

function sanitizeLoan(raw) {
  if (!isPlainObject(raw)) return null;
  const person = cleanText(raw.person, 60);
  const amount = parseAmount(raw.amount);
  if (!isValidId(raw.id) || person === '' || amount === null || !isValidISODate(raw.date)) {
    return null;
  }

  const hasInterest = raw.hasInterest === true;
  let rate = 0;
  let frequency = '';
  let firstPaymentDate = '';
  if (hasInterest) {
    rate = parsePercent(raw.rate);
    frequency = raw.frequency;
    if (rate === null || !FREQUENCIES.includes(frequency)) return null;

    // Día del primer cobro de interés. Si falta, o es anterior al préstamo,
    // se usa la fecha del préstamo + 1 periodo (la primera quincena, semana o mes).
    firstPaymentDate =
      isValidISODate(raw.firstPaymentDate) && raw.firstPaymentDate >= raw.date
        ? raw.firstPaymentDate
        : addPeriods(raw.date, frequency, 1);
  }

  return {
    id: raw.id,
    person,
    amount, // lo que prestaste originalmente
    date: raw.date, // día en que se prestó el dinero
    hasInterest,
    rate,
    frequency,
    firstPaymentDate, // primer día de cobro de interés ('' si no hay interés)
    interestPayments: hasInterest ? sanitizePayments(raw.interestPayments) : [],
    principalPayments: sanitizePayments(raw.principalPayments), // capital que ya te devolvieron
  };
}

/** Cantidad opcional: devuelve 0 si está vacía o no es válida. */
function optionalAmount(value) {
  const n = parseAmount(value);
  return n === null ? 0 : n;
}

function sanitizeDebt(raw) {
  if (!isPlainObject(raw)) return null;
  const concept = cleanText(raw.concept, 60);
  const total = parseAmount(raw.total);
  const payment = parseAmount(raw.payment);
  if (
    !isValidId(raw.id) ||
    concept === '' ||
    total === null ||
    payment === null ||
    !FREQUENCIES.includes(raw.frequency) ||
    !isValidISODate(raw.date)
  ) {
    return null;
  }

  // Día en que toca el primer pago. Si falta o no es válido,
  // usamos la fecha en que se registró la deuda.
  const firstPaymentDate = isValidISODate(raw.firstPaymentDate)
    ? raw.firstPaymentDate
    : raw.date;

  // Datos opcionales de compras a crédito (Coppel, Electra, etc.)
  const cashPrice = optionalAmount(raw.cashPrice);       // precio de contado (0 = no se capturó)
  const settleAmount = optionalAmount(raw.settleAmount); // "liquidar hoy" que da la tienda
  const settleDate =
    settleAmount > 0 && isValidISODate(raw.settleDate) ? raw.settleDate : '';

  // Tasa de interés por periodo (0.01277 = 1.277% por semana, quincena o mes).
  // La calcula la app al registrar la deuda. 0 = deuda sin interés.
  const rawRate = Number(raw.periodRate);
  const periodRate = Number.isFinite(rawRate) && rawRate > 0 && rawRate <= 1 ? rawRate : 0;

  return {
    id: raw.id,
    concept,
    total, // total a pagar CON intereses (el del contrato)
    payment,
    frequency: raw.frequency,
    date: raw.date, // fecha en que se registró la deuda
    firstPaymentDate, // primer día de pago; los demás se calculan desde aquí
    cashPrice,
    periodRate,
    settleAmount,
    settleDate, // día en que se anotó el monto de "liquidar hoy"
    payments: sanitizePayments(raw.payments),
  };
}

const SANITIZERS = {
  transactions: sanitizeTransaction,
  loans: sanitizeLoan,
  debts: sanitizeDebt,
};

/* =========================================================
   2. LEER Y GUARDAR
   ========================================================= */

function emptyData() {
  return { version: CURRENT_VERSION, transactions: [], loans: [], debts: [] };
}

/** Limpia un objeto completo. Devuelve los datos y cuántos registros se descartaron. */
function sanitizeData(parsed) {
  if (!isPlainObject(parsed)) throw new Error('Formato inválido');
  const data = emptyData();
  let dropped = 0;
  for (const name of Object.keys(SANITIZERS)) {
    const list = Array.isArray(parsed[name]) ? parsed[name] : [];
    for (const item of list) {
      const clean = SANITIZERS[name](item);
      if (clean) data[name].push(clean);
      else dropped++;
    }
  }
  return { data, dropped };
}

function keepCorruptCopy(raw) {
  try {
    localStorage.setItem(CORRUPT_KEY, raw);
  } catch {
    /* si ni eso se puede, no hay nada más que hacer */
  }
}

function load() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return emptyData(); // el navegador bloquea el almacenamiento
  }
  if (raw === null) return emptyData();

  try {
    const { data, dropped } = sanitizeData(JSON.parse(raw));
    if (dropped > 0) keepCorruptCopy(raw); // por si quieres recuperar algo a mano
    return data;
  } catch {
    keepCorruptCopy(raw);
    return emptyData();
  }
}

// Los datos viven en memoria; se cargan la primera vez que se necesitan.
let data = null;

function db() {
  if (data === null) data = load();
  return data;
}

/** Por qué falló un guardado: 'full' (sin espacio), 'blocked' (el navegador lo bloquea) u 'other'. */
function saveErrorKind(error) {
  const name = error && error.name;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || (error && (error.code === 22 || error.code === 1014))) {
    return 'full';
  }
  if (name === 'SecurityError') return 'blocked';
  return 'other';
}

/** Avisa a la pantalla que no se pudo guardar (main.js muestra el mensaje). Sale después del aviso de cada módulo. */
function reportSaveFailure(error) {
  const kind = saveErrorKind(error);
  setTimeout(() => {
    try {
      document.dispatchEvent(new CustomEvent('finanzas:guardado-fallo', { detail: kind }));
    } catch {
      /* sin pantalla (pruebas): no pasa nada */
    }
  }, 0);
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db()));
  } catch (error) {
    console.error('No se pudo guardar:', error);
    reportSaveFailure(error);
    return false;
  }
  try {
    localStorage.removeItem(CLEARED_KEY); // ya hay datos nuevos: la marca de "borrado a propósito" deja de servir
  } catch {
    /* no es grave */
  }
  touchMeta();
  scheduleMirror();
  return true;
}

/* ---- Copia interna (IndexedDB, ver vault.js) ---- */

let mirrorTimer = null;

/** Programa la actualización de la copia interna (si hay varios cambios seguidos, se hace una sola vez). */
function scheduleMirror() {
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(flushMirror, MIRROR_DELAY_MS);
}

/** Actualiza la copia interna ya mismo. */
export function flushMirror() {
  clearTimeout(mirrorTimer);
  mirrorTimer = null;
  if (data === null) return Promise.resolve(false);
  return vaultSave(JSON.stringify(data), todayISO());
}

/* ---- Marcas de tiempo (respaldos y avisos) ---- */

const META_DATE_FIELDS = ['lastBackup', 'lastChange', 'firstChange', 'snoozeBackupUntil', 'snoozeInstallUntil'];

function readMeta() {
  const meta = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(META_KEY) ?? 'null');
    if (isPlainObject(parsed)) {
      for (const field of META_DATE_FIELDS) {
        const value = parsed[field];
        if (typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value))) meta[field] = value;
      }
    }
  } catch {
    /* sin marcas todavía */
  }
  return meta;
}

function writeMeta(meta) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* si no cabe, solo se pierde el recordatorio */
  }
}

/** Anota que hubo un cambio (para saber si hay algo nuevo sin respaldar). */
function touchMeta() {
  const meta = readMeta();
  const now = new Date().toISOString();
  meta.lastChange = now;
  if (!meta.firstChange) meta.firstChange = now;
  writeMeta(meta);
}

// Si la app está abierta en dos pestañas, la otra pestaña pudo cambiar
// los datos: recargamos para no pisar sus cambios al guardar.
window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY) data = load();
});

// Al salir de la app o mandarla al fondo, la copia interna se actualiza sin esperar
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && mirrorTimer !== null) flushMirror();
});
window.addEventListener('pagehide', () => {
  if (mirrorTimer !== null) flushMirror();
});

/* =========================================================
   3. FUNCIONES PÚBLICAS: lo único que usan los demás archivos
   ========================================================= */

/** Devuelve una COPIA de la lista ('transactions', 'loans' o 'debts'). */
export function getItems(collection) {
  if (!SANITIZERS[collection]) return [];
  return structuredClone(db()[collection]);
}

/** Agrega un registro. Devuelve el registro guardado, o null si no es válido o no se pudo guardar. */
export function addItem(collection, raw) {
  const sanitize = SANITIZERS[collection];
  if (!sanitize || !isPlainObject(raw)) return null;

  const clean = sanitize({ ...raw, id: newId() });
  if (!clean) return null;

  const list = db()[collection];
  list.push(clean);
  if (!save()) {
    list.pop(); // deshacer si no se pudo guardar
    return null;
  }
  return structuredClone(clean);
}

/** Cambia campos de un registro existente. Devuelve el registro nuevo o null. */
export function updateItem(collection, id, changes) {
  const sanitize = SANITIZERS[collection];
  if (!sanitize || !isPlainObject(changes)) return null;

  const list = db()[collection];
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return null;

  const previous = list[index];
  const clean = sanitize({ ...previous, ...changes, id: previous.id });
  if (!clean) return null;

  list[index] = clean;
  if (!save()) {
    list[index] = previous;
    return null;
  }
  return structuredClone(clean);
}

/** Elimina un registro. Devuelve true si se eliminó y se guardó. */
export function removeItem(collection, id) {
  if (!SANITIZERS[collection]) return false;

  const list = db()[collection];
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return false;

  const [removed] = list.splice(index, 1);
  if (!save()) {
    list.splice(index, 0, removed);
    return false;
  }
  return true;
}

/* =========================================================
   4. PROTECCIÓN Y RESPALDO
   ========================================================= */

/** Le pide al teléfono que no borre los datos si le falta espacio. */
export async function requestPersistence() {
  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Cómo está la protección del almacenamiento:
 * { supported, persisted, usage, quota } (usage y quota en bytes, o null si el navegador no los da).
 */
export async function getPersistenceInfo() {
  const info = { supported: false, persisted: false, usage: null, quota: null };
  try {
    if (navigator.storage && typeof navigator.storage.persisted === 'function') {
      info.supported = true;
      info.persisted = await navigator.storage.persisted();
    }
  } catch {
    /* el navegador no contesta: queda como "no garantizado" */
  }
  try {
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      const estimate = await navigator.storage.estimate();
      info.usage = Number.isFinite(estimate.usage) ? estimate.usage : null;
      info.quota = Number.isFinite(estimate.quota) ? estimate.quota : null;
    }
  } catch {
    /* igual */
  }
  return info;
}

/** ¿El navegador deja guardar datos? (En algunos modos privados o con ajustes estrictos no.) */
export function canStoreData() {
  try {
    const probe = 'finanzas-app:probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Devuelve todos los datos como texto JSON (para el respaldo). */
export function exportBackup() {
  return JSON.stringify(db(), null, 2);
}

/** Restaura un respaldo. Todo se valida igual que al leer. Devuelve true o false. */
export function importBackup(text) {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_BYTES) return false;
  try {
    const { data: clean } = sanitizeData(JSON.parse(text));
    const previous = data;
    data = clean;
    if (!save()) {
      data = previous;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}


/* =========================================================
   4a. RECUPERACIÓN AUTOMÁTICA Y RECORDATORIO DE RESPALDO
   ========================================================= */

function countRecords(clean) {
  return Object.keys(SANITIZERS).reduce((sum, name) => sum + clean[name].length, 0);
}

/**
 * Se llama UNA vez al abrir la app, antes de mostrar datos.
 * Si localStorage está vacío (o dañado) pero la copia interna tiene tus datos,
 * los recupera. Si borraste tus datos a propósito, NO recupera nada.
 * Devuelve { savedAt, records } si recuperó, o null.
 */
export async function recoverFromVault() {
  let raw;
  let clearedOnPurpose;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    clearedOnPurpose = localStorage.getItem(CLEARED_KEY) !== null;
  } catch {
    return null; // el navegador bloquea el almacenamiento: no hay dónde recuperar
  }

  let needsRecovery = raw === null;
  if (raw !== null) {
    try {
      JSON.parse(raw);
    } catch {
      keepCorruptCopy(raw); // por si quieres rescatar algo a mano
      needsRecovery = true;
    }
  }

  if (!needsRecovery) {
    // Todo bien: se asegura que exista una copia interna (la primera vez después de actualizar la app)
    db();
    scheduleMirror();
    return null;
  }
  if (raw === null && clearedOnPurpose) return null;

  for (const snapshot of await vaultRead()) {
    try {
      const { data: clean } = sanitizeData(JSON.parse(snapshot.json));
      const records = countRecords(clean);
      if (records === 0) continue; // una copia vacía no sirve para recuperar
      data = clean;
      if (!save()) {
        data = null;
        return null;
      }
      return { savedAt: snapshot.savedAt, records };
    } catch {
      /* esta copia no sirve: se prueba la anterior */
    }
  }
  return null;
}

/** Anota que se descargó un respaldo (PDF o Excel: los dos llevan una copia completa de los datos). */
export function markBackupDone() {
  const meta = readMeta();
  meta.lastBackup = new Date().toISOString();
  writeMeta(meta);
}

/**
 * Estado del respaldo para el recordatorio:
 * { hasData, lastBackup (texto ISO o null), daysSince (días desde el último respaldo, o null si nunca), due }
 * "due" = ya toca avisar: hay datos, pasaron 7 días o más, hubo cambios desde el último respaldo y no se pospuso.
 */
export function getBackupStatus(now = new Date()) {
  const hasData = countRecords(db()) > 0;
  const meta = readMeta();
  if (hasData && !meta.firstChange) {
    meta.firstChange = now.toISOString(); // datos de antes de existir el recordatorio: se empieza a contar hoy
    writeMeta(meta);
  }

  const lastBackup = meta.lastBackup ?? null;
  const daysSince = lastBackup ? Math.max(0, Math.floor((now - Date.parse(lastBackup)) / DAY_MS)) : null;
  const reference = Date.parse(lastBackup ?? meta.firstChange ?? now.toISOString());
  const waited = Math.floor((now - reference) / DAY_MS) >= 7;
  const changedSince = !lastBackup || (meta.lastChange && Date.parse(meta.lastChange) > Date.parse(lastBackup));
  const snoozed = meta.snoozeBackupUntil && Date.parse(meta.snoozeBackupUntil) > now.getTime();

  return { hasData, lastBackup, daysSince, due: Boolean(hasData && waited && changedSince && !snoozed) };
}

/** Pospone un aviso: kind = 'backup' o 'install'. */
export function snoozeNotice(kind, days) {
  if (kind !== 'backup' && kind !== 'install') return;
  const meta = readMeta();
  meta[kind === 'backup' ? 'snoozeBackupUntil' : 'snoozeInstallUntil'] = new Date(Date.now() + days * DAY_MS).toISOString();
  writeMeta(meta);
}

/** ¿Este aviso está pospuesto todavía? */
export function isNoticeSnoozed(kind) {
  const meta = readMeta();
  const until = kind === 'backup' ? meta.snoozeBackupUntil : meta.snoozeInstallUntil;
  return Boolean(until && Date.parse(until) > Date.now());
}

/** Fecha y hora de la última copia interna (texto ISO) o null. */
export async function getVaultInfo() {
  const [latest] = await vaultRead();
  return latest ? latest.savedAt : null;
}

/* =========================================================
   4b. RESTAURAR DESDE UN ARCHIVO (PDF o Excel descargado)
   Se AGREGA lo que falta; lo que ya existe (mismo id) no se duplica.
   Todo se valida igual que al leer o al agregar un dato.
   ========================================================= */

/**
 * Revisa un respaldo SIN guardar nada.
 * Devuelve { total, fresh } con cuántos registros trae de cada tipo y
 * cuántos serían nuevos, o null si no tiene un formato válido.
 */
export function previewMerge(rawData) {
  let clean;
  try {
    clean = sanitizeData(rawData).data;
  } catch {
    return null;
  }

  const current = db();
  const total = {};
  const fresh = {};
  for (const name of Object.keys(SANITIZERS)) {
    const ids = new Set(current[name].map((item) => item.id));
    total[name] = clean[name].length;
    fresh[name] = clean[name].filter((item) => !ids.has(item.id)).length;
  }
  return { total, fresh };
}

/**
 * Agrega a la app lo que traiga el respaldo y todavía no exista.
 * Devuelve { added, skipped } o null si no se pudo (y entonces no cambia nada).
 */
export function mergeBackup(rawData) {
  let clean;
  try {
    clean = sanitizeData(rawData).data;
  } catch {
    return null;
  }

  const previous = structuredClone(db());
  const current = db();
  const added = { transactions: 0, loans: 0, debts: 0 };
  let skipped = 0;

  for (const name of Object.keys(SANITIZERS)) {
    const ids = new Set(current[name].map((item) => item.id));
    for (const item of clean[name]) {
      if (ids.has(item.id)) {
        skipped++;
        continue;
      }
      current[name].push(item);
      ids.add(item.id);
      added[name]++;
    }
  }

  if (!save()) {
    data = previous; // se deshace todo si no cupo
    return null;
  }
  return { added, skipped };
}

/**
 * Borra TODOS los datos guardados (movimientos, deudas y préstamos).
 * El tema (claro/oscuro) se conserva. Devuelve true si se pudo.
 */
export function clearAllData() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(CORRUPT_KEY);
    localStorage.removeItem(META_KEY);
    localStorage.setItem(CLEARED_KEY, '1'); // así la copia interna no "resucita" lo que borraste
  } catch (error) {
    console.error('No se pudieron borrar los datos:', error);
    return false;
  }
  clearTimeout(mirrorTimer);
  mirrorTimer = null;
  data = emptyData();
  vaultClear(); // también se borra la copia interna (no lanza errores)
  return true;
}

/* =========================================================
   5. TEMA (modo claro / oscuro)
   Se guarda aparte de los datos: no entra en los respaldos
   y no se borra si restauras uno.
   ========================================================= */

const THEME_KEY = 'finanzas-app:theme';

/** Devuelve 'light', 'dark' o null si todavía no se ha elegido. */
export function getTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** Guarda la elección. Devuelve true si se pudo guardar. */
export function setTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return false;
  try {
    localStorage.setItem(THEME_KEY, theme);
    return true;
  } catch {
    return false;
  }
}
