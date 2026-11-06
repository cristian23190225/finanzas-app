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
} from './utils.js';

const STORAGE_KEY = 'finanzas-app:data';
const CORRUPT_KEY = 'finanzas-app:data-corrupt';
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

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db()));
    return true;
  } catch (error) {
    console.error('No se pudo guardar:', error);
    return false;
  }
}

// Si la app está abierta en dos pestañas, la otra pestaña pudo cambiar
// los datos: recargamos para no pisar sus cambios al guardar.
window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY) data = load();
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
  } catch (error) {
    console.error('No se pudieron borrar los datos:', error);
    return false;
  }
  data = emptyData();
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
