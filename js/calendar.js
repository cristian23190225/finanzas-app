/* =========================================================
   calendar.js
   Dibuja el calendario del mes actual, marca el día de hoy
   y muestra la fecha completa debajo.
   Se actualiza solo cuando cambia el día (aunque dejes la
   app abierta toda la noche).
   ========================================================= */

import { clear, el, formatLongDate, parseISODate, todayISO } from './utils.js';

// Con qué día empieza la semana: 0 = domingo, 1 = lunes
const WEEK_STARTS_ON = 0;
const WEEKDAYS = ['D', 'L', 'M', 'M', 'J', 'V', 'S']; // empieza en domingo

const monthFormatter = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' });

let shownDay = null; // el día que el calendario muestra ahora
const dayChangeListeners = [];

/** Letras de los días, ordenadas según WEEK_STARTS_ON. */
function weekdayLabels() {
  return WEEKDAYS.map((_, i) => WEEKDAYS[(i + WEEK_STARTS_ON) % 7]);
}

/** Dibuja el calendario del mes al que pertenece "todayIso". */
function renderCalendar(todayIso) {
  const grid = document.getElementById('calendar-grid');
  const label = document.getElementById('today-label');
  const today = parseISODate(todayIso);
  if (!grid || !label || !today) return;

  const year = today.getFullYear();
  const month = today.getMonth();

  clear(grid);

  // Título: "noviembre de 2026"
  grid.appendChild(el('div', monthFormatter.format(today), 'calendar__title'));

  // Letras de los días de la semana
  for (const letter of weekdayLabels()) {
    grid.appendChild(el('div', letter, 'calendar__weekday'));
  }

  // Espacios vacíos antes del día 1
  const firstWeekday = new Date(year, month, 1).getDay();
  const emptyCells = (firstWeekday - WEEK_STARTS_ON + 7) % 7;
  for (let i = 0; i < emptyCells; i++) {
    grid.appendChild(el('div'));
  }

  // Los días del mes
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const cell = el('div', String(day), 'calendar__day');
    if (day === today.getDate()) {
      cell.classList.add('is-today');
      cell.setAttribute('aria-current', 'date');
    }
    grid.appendChild(cell);
  }

  // Fecha completa debajo: "martes, 3 de noviembre de 2026"
  label.textContent = formatLongDate(todayIso);
}

/** Revisa si ya cambió el día; si cambió, redibuja y avisa. */
function checkDayChange() {
  const now = todayISO();
  if (now === shownDay) return;

  const previous = shownDay;
  shownDay = now;
  renderCalendar(now);
  for (const listener of dayChangeListeners) listener(now, previous);
}

/** Registra una función que se ejecuta cuando cambia el día. */
export function onDayChange(listener) {
  dayChangeListeners.push(listener);
}

/** Arranca el calendario. Se llama una sola vez desde main.js. */
export function initCalendar() {
  shownDay = todayISO();
  renderCalendar(shownDay);

  // Revisa cada minuto...
  setInterval(checkDayChange, 60 * 1000);
  // ...y también al volver a la app (el teléfono congela los temporizadores
  // cuando la app está en segundo plano).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkDayChange();
  });
  window.addEventListener('pageshow', checkDayChange);
}