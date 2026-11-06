/* =========================================================
   calendar.js
   Dibuja el calendario, marca el día de hoy y permite elegir un
   día que ya pasó para registrar movimientos que se te olvidaron.

   Reglas:
     - No se pueden elegir días futuros.
     - No se puede ir antes del primer movimiento que hayas registrado
       (ingreso, ahorro, gasto, retiro, deuda o préstamo).
     - Al elegir un día pasado, los movimientos nuevos se guardan con
       esa fecha y aparece un contador de 5 minutos: al llegar a cero
       vuelves solo a hoy.
     - Si sales de la app (o la cierras), vuelves a hoy al instante.
   Se actualiza solo cuando cambia el día (aunque dejes la app abierta
   toda la noche).
   ========================================================= */

import { getItems } from './storage.js';
import { showToast } from './ui.js';
import { clear, el, formatLongDate, formatShortDate, monthKey, parseISODate, todayISO } from './utils.js';

// Con qué día empieza la semana: 0 = domingo, 1 = lunes
const WEEK_STARTS_ON = 0;
const WEEKDAYS = ['D', 'L', 'M', 'M', 'J', 'V', 'S']; // empieza en domingo

const RETURN_AFTER_MS = 5 * 60 * 1000; // a los 5 minutos de elegir el día, se vuelve a hoy
const TICK_MS = 10 * 1000; // cada cuánto se revisa si cambió el día
const COUNTDOWN_MS = 1000; // el contador del aviso se mueve cada segundo

const monthFormatter = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' });

let shownDay = null; // el "hoy" real que el calendario conoce
let selectedDay = null; // día pasado elegido ("AAAA-MM-DD"), o null = se usa hoy
let returnAt = 0; // momento (ms) en que se vuelve a hoy
let countdownTimer = null; // temporizador del contador (solo existe mientras hay un día elegido)
let leftNotice = false; // true = hay que avisar, al volver a la app, que se regresó a hoy
let viewYear = 0; // mes que se está viendo en el calendario
let viewMonth = 0; // 0 = enero

const dayChangeListeners = [];
const activeDateListeners = [];

/* =========================================================
   1. DÍA ACTIVO: la fecha con la que se guardan los movimientos nuevos
   ========================================================= */

/** El día en el que se está registrando: el elegido en el calendario, o si no, hoy. */
export function activeDate() {
  return selectedDay ?? todayISO();
}

/** Registra una función que se ejecuta cuando cambia el día activo: (nuevo, anterior). */
export function onActiveDateChange(listener) {
  activeDateListeners.push(listener);
}

/** Registra una función que se ejecuta cuando cambia el día real (pasó la medianoche). */
export function onDayChange(listener) {
  dayChangeListeners.push(listener);
}

/** Fecha del movimiento más antiguo (o hoy, si todavía no hay ninguno). */
function firstMovementDate(today) {
  let first = today;
  for (const collection of ['transactions', 'loans', 'debts']) {
    for (const item of getItems(collection)) {
      if (typeof item.date === 'string' && item.date < first) first = item.date;
    }
  }
  return first;
}

/* =========================================================
   2. DIBUJO
   ========================================================= */

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Letras de los días, ordenadas según WEEK_STARTS_ON. */
function weekdayLabels() {
  return WEEKDAYS.map((_, i) => WEEKDAYS[(i + WEEK_STARTS_ON) % 7]);
}

function resetViewToToday() {
  const today = parseISODate(todayISO());
  if (!today) return;
  viewYear = today.getFullYear();
  viewMonth = today.getMonth();
}

function moveMonth(delta) {
  const target = new Date(viewYear, viewMonth + delta, 1);
  viewYear = target.getFullYear();
  viewMonth = target.getMonth();
  renderCalendar();
}

function arrowButton(symbol, label, disabled, onClick) {
  const button = el('button', symbol, 'calendar__arrow');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

/** Dibuja el mes que se está viendo. */
function renderCalendar() {
  const grid = document.getElementById('calendar-grid');
  const label = document.getElementById('today-label');
  const today = todayISO();
  if (!grid || !label || !parseISODate(today)) return;

  const first = firstMovementDate(today);
  const viewKey = `${viewYear}-${pad(viewMonth + 1)}`;

  clear(grid);

  // Título con flechas: "‹  noviembre de 2026  ›"
  const head = el('div', '', 'calendar__head');
  head.appendChild(arrowButton('‹', 'Mes anterior', viewKey <= monthKey(first), () => moveMonth(-1)));
  head.appendChild(el('div', monthFormatter.format(new Date(viewYear, viewMonth, 1)), 'calendar__title'));
  head.appendChild(arrowButton('›', 'Mes siguiente', viewKey >= monthKey(today), () => moveMonth(1)));
  grid.appendChild(head);

  // Letras de los días de la semana
  for (const letter of weekdayLabels()) {
    grid.appendChild(el('div', letter, 'calendar__weekday'));
  }

  // Espacios vacíos antes del día 1
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const emptyCells = (firstWeekday - WEEK_STARTS_ON + 7) % 7;
  for (let i = 0; i < emptyCells; i++) {
    grid.appendChild(el('div'));
  }

  // Los días del mes (cada uno es un botón)
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${viewKey}-${pad(day)}`;
    const cell = el('button', String(day), 'calendar__day');
    cell.type = 'button';
    cell.setAttribute('aria-label', formatLongDate(iso));

    if (iso === today) {
      cell.classList.add('is-today');
      cell.setAttribute('aria-current', 'date');
    }
    if (iso === selectedDay) {
      cell.classList.add('is-selected');
      cell.setAttribute('aria-pressed', 'true');
    }
    if (iso > today || iso < first) {
      cell.classList.add('is-disabled');
      cell.setAttribute('aria-disabled', 'true');
    }

    cell.addEventListener('click', () => onDayClick(iso));
    grid.appendChild(cell);
  }

  // Fecha completa debajo: "martes, 3 de noviembre de 2026"
  const active = activeDate();
  label.textContent = selectedDay ? `Día seleccionado: ${formatLongDate(active)}` : formatLongDate(active);
}

/** "4:32" a partir de milisegundos. */
function formatCountdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

/** Franja de aviso (con contador y barra) que se ve en todas las pantallas mientras estás en un día pasado. */
function updateBanner() {
  const banner = document.getElementById('date-banner');
  const text = document.getElementById('date-banner-text');
  const timer = document.getElementById('date-banner-timer');
  const fill = document.getElementById('date-banner-fill');
  if (!banner || !text) return;

  banner.hidden = selectedDay === null;
  if (selectedDay === null) return;

  const remaining = Math.max(0, returnAt - Date.now());
  text.textContent = `Registrando en: ${formatLongDate(selectedDay)}`;
  if (timer) timer.textContent = `Vuelves a hoy en ${formatCountdown(remaining)}`;
  if (fill) fill.style.transform = `scaleX(${Math.min(1, remaining / RETURN_AFTER_MS)})`;
}

/** Hace que el contador del aviso se mueva cada segundo (solo mientras hay un día elegido). */
function startCountdown() {
  stopCountdown();
  countdownTimer = setInterval(() => {
    if (selectedDay === null) return stopCountdown();
    if (Date.now() >= returnAt) setSelectedDay(null, 'timeout');
    else updateBanner();
  }, COUNTDOWN_MS);
}

function stopCountdown() {
  if (countdownTimer !== null) clearInterval(countdownTimer);
  countdownTimer = null;
}

/* =========================================================
   3. ELEGIR UN DÍA
   ========================================================= */

function onDayClick(iso) {
  const today = todayISO();

  if (iso > today) {
    showToast('No puedes elegir un día que todavía no llega.', 'error');
    return;
  }

  const first = firstMovementDate(today);
  if (iso < first) {
    showToast(
      first === today
        ? 'Todavía no tienes movimientos, así que no hay días anteriores para elegir.'
        : `No puedes ir antes de tu primer movimiento (${formatShortDate(first)}).`,
      'error'
    );
    return;
  }

  if (iso === today) {
    if (selectedDay !== null) setSelectedDay(null, 'manual');
    return;
  }

  if (iso !== selectedDay) {
    setSelectedDay(iso);
    return;
  }

  // Tocar otra vez el día elegido reinicia los 5 minutos
  returnAt = Date.now() + RETURN_AFTER_MS;
  updateBanner();
  showToast('Reiniciaste el contador: tienes 5 minutos más en este día.');
}

/**
 * Cambia el día activo. iso = null vuelve a hoy.
 * reason: 'manual' (tú lo pediste), 'timeout' (se acabó el contador) o
 * 'left' (saliste de la app).
 */
function setSelectedDay(iso, reason = '') {
  const previous = activeDate();
  selectedDay = iso;

  if (iso !== null) {
    returnAt = Date.now() + RETURN_AFTER_MS;
    const date = parseISODate(iso);
    viewYear = date.getFullYear();
    viewMonth = date.getMonth();
    startCountdown();
  } else {
    returnAt = 0;
    stopCountdown();
    resetViewToToday();
  }

  renderCalendar();
  updateBanner();

  if (iso !== null) {
    showToast(
      `Ahora registras en: ${formatLongDate(iso)}. Tienes 5 minutos; después vuelves al día de hoy.`
    );
  } else if (reason === 'timeout') {
    showToast('Se acabó el tiempo: volviste al día de hoy.');
  } else if (reason === 'manual') {
    showToast('Volviste al día de hoy.');
  }

  const now = activeDate();
  if (now !== previous) {
    for (const listener of activeDateListeners) listener(now, previous);
  }
}

/* =========================================================
   4. RELOJ: vuelve a hoy solo, y detecta el cambio de día
   ========================================================= */

/** Revisa si ya cambió el día real; si cambió, redibuja y avisa. */
function checkDayChange() {
  const now = todayISO();
  if (now === shownDay) return;

  const previous = shownDay;
  shownDay = now;
  if (selectedDay === null) resetViewToToday();
  renderCalendar();
  for (const listener of dayChangeListeners) listener(now, previous);
}

function tick() {
  if (selectedDay !== null && Date.now() >= returnAt) setSelectedDay(null, 'timeout');
  checkDayChange();
  updateBanner();
}

/** Saliste de la app (o la cerraste): se vuelve a hoy al instante. */
function leaveToToday() {
  if (selectedDay === null) return;
  setSelectedDay(null, 'left');
  leftNotice = true; // el aviso se muestra cuando regreses a la app
}

/** Volviste a la app. */
function comeBack() {
  if (leftNotice) {
    leftNotice = false;
    showToast('Saliste de la app, así que volviste al día de hoy.');
  }
  tick();
}

/** Vuelve a dibujar el calendario (por ejemplo, tras restaurar datos: cambia el primer movimiento). */
export function refreshCalendar() {
  // Si el día elegido ya no es válido (por ejemplo, se borraron los datos), se vuelve a hoy
  if (selectedDay !== null && selectedDay < firstMovementDate(todayISO())) {
    setSelectedDay(null, 'manual');
    return;
  }
  renderCalendar();
  updateBanner();
}

/** Arranca el calendario. Se llama una sola vez desde main.js. */
export function initCalendar() {
  shownDay = todayISO();
  selectedDay = null;
  resetViewToToday();
  renderCalendar();
  updateBanner();

  const backToToday = document.getElementById('date-banner-today');
  if (backToToday) backToToday.addEventListener('click', () => setSelectedDay(null, 'manual'));

  // Se revisa cada pocos segundos si cambió el día...
  setInterval(tick, TICK_MS);

  // ...y al salir de la app (cambiar de app, bloquear el teléfono, cerrarla)
  // se vuelve a hoy. Al regresar se vuelve a revisar todo: el teléfono congela
  // los temporizadores en segundo plano, pero el reloj real sigue corriendo.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') leaveToToday();
    else comeBack();
  });
  window.addEventListener('pagehide', leaveToToday);
  window.addEventListener('pageshow', comeBack);
}
