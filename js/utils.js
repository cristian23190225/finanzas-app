/* =========================================================
   utils.js
   Funciones pequeñas y reutilizables: fechas, dinero,
   validación de lo que se escribe y ayudas para el DOM.
   No guarda nada ni toca la pantalla por su cuenta.
   ========================================================= */

/* ---------- Constantes ---------- */

export const FREQUENCIES = ['semanal', 'quincenal', 'mensual'];

export const FREQUENCY_LABELS = {
  semanal: 'Cada semana',
  quincenal: 'Cada quincena',
  mensual: 'Cada mes',
};

// Mismo tope que el atributo max="" de los formularios del HTML
export const MAX_AMOUNT = 999999999;

/* ---------- Fechas ---------- */
// Importante: usamos la fecha LOCAL del teléfono, no la UTC.
// Con UTC, en México la fecha "cambiaría de día" a media tarde-noche.

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Convierte un objeto Date en texto "AAAA-MM-DD". */
export function toISODate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** La fecha de hoy como "AAAA-MM-DD". */
export function todayISO() {
  return toISODate(new Date());
}

/** Convierte "AAAA-MM-DD" en Date. Devuelve null si no es una fecha real. */
export function parseISODate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const isReal =
    date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
  return isReal ? date : null;
}

export function isValidISODate(iso) {
  return parseISODate(iso) !== null;
}

/** "2026-11-03" -> "2026-11" (sirve para agrupar por mes). */
export function monthKey(iso) {
  return iso.slice(0, 7);
}

/** "2026-11-03" -> "martes, 3 de noviembre de 2026". */
export function formatLongDate(iso) {
  const date = parseISODate(iso);
  if (!date) return '';
  return new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/** "2026-11-03" -> "03/11/2026" (para tablas). */
export function formatShortDate(iso) {
  const date = parseISODate(iso);
  if (!date) return '';
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

const STEP_DAYS = { semanal: 7, quincenal: 15 };

/**
 * Suma "n" periodos a una fecha.
 *   semanal   = 7 días
 *   quincenal = 15 días
 *   mensual   = 1 mes calendario (31 ene + 1 mes = 28 feb)
 */
export function addPeriods(iso, frequency, n) {
  const start = parseISODate(iso);
  if (!start || !FREQUENCIES.includes(frequency)) return null;

  if (frequency === 'mensual') {
    const day = start.getDate();
    const target = new Date(start.getFullYear(), start.getMonth() + n, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, lastDay));
    return toISODate(target);
  }

  start.setDate(start.getDate() + STEP_DAYS[frequency] * n);
  return toISODate(start);
}

/**
 * Cuántos periodos de cobro/pago ya se cumplieron desde "startISO" hasta hoy.
 * Ejemplo: préstamo del 1 de enero, quincenal, hoy 31 de enero -> 2.
 */
export function countPeriods(startISO, frequency, untilISO = todayISO()) {
  let count = 0;
  // Tope de seguridad para que un dato raro nunca cree un ciclo infinito
  while (count < 5000) {
    const due = addPeriods(startISO, frequency, count + 1);
    if (due === null || due > untilISO) break; // texto ISO se compara bien
    count++;
  }
  return count;
}

/**
 * Cuántos pagos/cobros ya "vencieron" contando desde el primero.
 * El primero cuenta como uno (a diferencia de countPeriods).
 * Ejemplo: primero el 15 nov, quincenal, hoy 30 nov -> 2 (15 nov y 30 nov).
 */
export function countDue(firstISO, frequency, untilISO = todayISO()) {
  if (!isValidISODate(firstISO) || firstISO > untilISO) return 0;
  return countPeriods(firstISO, frequency, untilISO) + 1;
}

/** Días entre dos fechas "AAAA-MM-DD" (positivo si la segunda es posterior). */
export function daysBetween(fromISO, toISO) {
  const from = parseISODate(fromISO);
  const to = parseISODate(toISO);
  if (!from || !to) return 0;
  return Math.round((to - from) / 86400000);
}

/* ---------- Dinero ---------- */

/** Redondea a 2 decimales (evita cosas como 0.1 + 0.2 = 0.30000000000000004). */
export function roundMoney(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 1234.5 -> "$1,234.50" */
export function formatMoney(n) {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
  }).format(n);
}

/** Convierte lo escrito en una cantidad válida (> 0) o devuelve null. */
export function parseAmount(raw) {
  // Se aceptan comas de miles ("50,000.50"): se quitan antes de convertir
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
  return roundMoney(n);
}

/**
 * Pone comas de miles a lo que se escribe: "50000.5" -> "50,000.5".
 * Solo deja números y un punto decimal (máximo 2 decimales y 9 dígitos enteros).
 */
export function formatAmountText(raw) {
  const text = String(raw).replace(/,/g, '').replace(/[^0-9.]/g, '');
  const dot = text.indexOf('.');
  let integer = dot === -1 ? text : text.slice(0, dot);
  const decimals = dot === -1 ? null : text.slice(dot + 1).replace(/\./g, '').slice(0, 2);

  integer = integer.replace(/^0+(?=\d)/, '').slice(0, 9);
  if (integer === '' && decimals !== null) integer = '0';

  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimals === null ? grouped : `${grouped}.${decimals}`;
}

/** Igual, pero para porcentajes (entre 0.01 y 100). */
export function parsePercent(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return roundMoney(n);
}

/* ---------- Texto ---------- */

/**
 * Limpia un texto escrito por la persona:
 *  - lo convierte en texto normal si viene otra cosa
 *  - junta espacios y saltos de línea
 *  - quita caracteres invisibles o de control
 *  - lo corta al largo máximo
 * No intenta "arreglar" símbolos como < o >: no hace falta, porque
 * la app NUNCA interpreta el texto como HTML (siempre usa textContent).
 */
export function cleanText(raw, maxLength = 60) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .trim()
    .slice(0, maxLength);
}

/** Verifica que sea un objeto normal (no null, no lista). */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ---------- Identificadores ---------- */

export function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Un id solo puede tener letras, números, guion y guion bajo (y no nombres reservados de JavaScript). */
const RESERVED_IDS = ['__proto__', 'constructor', 'prototype'];

export function isValidId(id) {
  return typeof id === 'string' && /^[\w-]{1,64}$/.test(id) && !RESERVED_IDS.includes(id);
}

/* ---------- Ayudas para el DOM (siempre con textContent) ---------- */

/** Crea un elemento con texto seguro. Ejemplo: el('td', '$100.00', 'num') */
export function el(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text !== '') node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** Vacía un elemento sin usar innerHTML. */
export function clear(node) {
  node.replaceChildren();
}