/* =========================================================
   main.js
   Punto de entrada: arranca la app y maneja la navegación
   entre pantallas (Inicio, Resumen, Préstamos, Deudas).
   Se navega con los botones de arriba o deslizando el dedo
   hacia un lado (en el teléfono).
   ========================================================= */

import { activeDate, initCalendar, onActiveDateChange, onDayChange } from './calendar.js';
import { initDebts, renderDebts } from './debts.js';
import { hideSplash, initHome } from './home.js';
import { initMoneyInputs } from './money-input.js';
import { initExport } from './export.js';
import { initLoans, renderLoans } from './loans.js';
import { initPwa } from './pwa.js';
import { requestPersistence } from './storage.js';
import { initTheme } from './theme.js';
import { renderSettings } from './settings.js';
import { renderSummary } from './summary.js';
import { initTransactions } from './transactions.js';
import { clear, el } from './utils.js';

/* =========================================================
   1. NAVEGACIÓN
   ========================================================= */

// Las 4 pantallas de la barra de arriba. Su orden es el orden al deslizar el dedo.
const SWIPE_VIEWS = ['inicio', 'resumen', 'prestamos', 'deudas'];
// Todas las pantallas. "ajustes" no está en la barra: se abre con el engrane de Inicio.
const VIEWS = [...SWIPE_VIEWS, 'ajustes'];

// Cada pantalla que se llena con JavaScript registra aquí su función.
const VIEW_RENDERERS = {
  resumen: renderSummary,
  prestamos: renderLoans,
  deudas: renderDebts,
  ajustes: renderSettings,
};

// La pantalla que se está viendo
let currentView = 'inicio';

/** Mientras una pantalla no esté construida, muestra un aviso. */
function showPlaceholder(container) {
  clear(container);
  const card = el('section', '', 'card');
  card.appendChild(el('h2', 'Próximamente'));
  card.appendChild(el('p', 'Esta sección se construye en uno de los siguientes pasos.', 'card__total'));
  container.appendChild(card);
}

/** Si una pantalla falla al dibujarse, muestra el motivo en vez de quedarse en blanco. */
function showError(container, error) {
  clear(container);
  const card = el('section', '', 'card');
  card.appendChild(el('h2', 'No se pudo cargar esta sección'));
  card.appendChild(el('p', 'Detalle técnico (cópialo y mándamelo para ayudarte):', 'card__total'));
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  card.appendChild(el('p', detail, 'card__total'));
  container.appendChild(card);
}

/** Pequeña animación: la pantalla entra deslizándose desde el lado hacia donde vas. */
function animateIn(container, direction) {
  const className = `view--in-${direction}`;
  container.classList.remove('view--in-next', 'view--in-prev');
  void container.offsetWidth; // reinicia la animación si se repite rápido
  container.classList.add(className);
  container.addEventListener('animationend', () => container.classList.remove(className), { once: true });
}

/**
 * Muestra una pantalla y oculta las demás.
 * forcedDirection ('next' o 'prev') cambia hacia qué lado se desliza la animación.
 */
function showView(name, forcedDirection) {
  if (!VIEWS.includes(name)) return;

  const changed = name !== currentView;
  const direction = forcedDirection ?? (VIEWS.indexOf(name) > VIEWS.indexOf(currentView) ? 'next' : 'prev');
  currentView = name;

  // Le avisa al CSS en qué pantalla estamos (en Ajustes se esconde la barra de Inicio/Resumen/Préstamos/Deudas)
  document.body.setAttribute('data-view', name);

  for (const viewName of VIEWS) {
    const container = document.getElementById(`view-${viewName}`);
    if (container) container.hidden = viewName !== name;
  }

  for (const button of document.querySelectorAll('.nav__btn')) {
    const isActive = button.dataset.view === name;
    button.classList.toggle('is-active', isActive);
    if (isActive) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  // Dibuja la pantalla cada vez que se abre, para que muestre datos al día
  const container = document.getElementById(`view-${name}`);
  const render = VIEW_RENDERERS[name];
  if (container && render) {
    try {
      render(container);
    } catch (error) {
      console.error(`Error al dibujar la pantalla "${name}":`, error);
      showError(container, error);
    }
  } else if (container && name !== 'inicio') {
    showPlaceholder(container);
  }

  if (container && changed) animateIn(container, direction);

  window.scrollTo(0, 0);
}

function initNavigation() {
  for (const button of document.querySelectorAll('.nav__btn')) {
    button.addEventListener('click', () => showView(button.dataset.view));
  }

  // El engrane de la pantalla de Inicio abre Ajustes
  const settingsButton = document.getElementById('btn-settings');
  if (settingsButton) settingsButton.addEventListener('click', () => showView('ajustes'));

  // Otros archivos (como settings.js) piden cambiar de pantalla con este aviso
  document.addEventListener('finanzas:ver', (event) => {
    if (typeof event.detail === 'string') showView(event.detail);
  });
}

/* =========================================================
   2. DESLIZAR EL DEDO PARA CAMBIAR DE PANTALLA
   Izquierda = siguiente pantalla · Derecha = la anterior.
   Los botones de arriba siguen funcionando igual.
   ========================================================= */

const SWIPE_MIN_DISTANCE = 60; // píxeles mínimos hacia un lado
const SWIPE_MAX_TIME = 700;    // milisegundos como máximo
const SWIPE_DOMINANCE = 1.5;   // tiene que ser 1.5 veces más horizontal que vertical
const EDGE_GUARD = 24;         // los gestos desde el borde son del sistema (ej. "atrás" del iPhone)

let touchStart = null;

/** ¿Este elemento está dentro de algo que se desplaza hacia los lados por sí solo? */
function insideHorizontalScroller(node) {
  for (let n = node; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const overflowX = getComputedStyle(n).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
  }
  return false;
}

/** ¿Hay que ignorar este gesto? (campos, ventanitas abiertas, zonas con scroll lateral) */
function isSwipeBlocked(target) {
  if (!(target instanceof Element)) return true;
  if (document.querySelector('dialog[open]')) return true;
  if (target.closest('input, select, textarea, dialog, [contenteditable="true"]')) return true;
  return insideHorizontalScroller(target);
}

function initSwipe() {
  document.addEventListener(
    'touchstart',
    (event) => {
      // Más de un dedo (zoom, etc.): no es un deslizamiento de pantalla
      if (event.touches.length !== 1) {
        touchStart = null;
        return;
      }
      const touch = event.touches[0];
      const nearEdge = touch.clientX < EDGE_GUARD || touch.clientX > window.innerWidth - EDGE_GUARD;
      if (nearEdge || isSwipeBlocked(event.target)) {
        touchStart = null;
        return;
      }
      touchStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    },
    { passive: true }
  );

  document.addEventListener(
    'touchend',
    (event) => {
      if (!touchStart) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - touchStart.x;
      const dy = touch.clientY - touchStart.y;
      const elapsed = Date.now() - touchStart.time;
      touchStart = null;

      if (elapsed > SWIPE_MAX_TIME) return;
      if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return;
      if (Math.abs(dx) < Math.abs(dy) * SWIPE_DOMINANCE) return;
      if (window.getSelection()?.toString()) return; // estabas seleccionando texto

      // Izquierda (dx < 0) = siguiente · Derecha = anterior. En los extremos no pasa nada.
      const index = SWIPE_VIEWS.indexOf(currentView);
      if (index === -1) {
        // En Ajustes: deslizar a la derecha regresa a Inicio (el resto no hace nada)
        if (currentView === 'ajustes' && dx > 0) showView('inicio', 'prev');
        return;
      }
      const target = SWIPE_VIEWS[index + (dx < 0 ? 1 : -1)];
      if (target) showView(target);
    },
    { passive: true }
  );

  document.addEventListener(
    'touchcancel',
    () => {
      touchStart = null;
    },
    { passive: true }
  );
}

/* =========================================================
   3. FECHAS POR DEFECTO
   Solo la "Fecha del préstamo" arranca con la fecha de hoy.
   Estos campos se dejan VACÍOS a propósito, porque tú eliges la fecha:
     - "Fecha del primer pago" de Deudas
     - "Fecha del primer cobro de interés" de Préstamos
     (si dejas vacío el de Préstamos, se calcula solo)
   ========================================================= */

const TODAY_FIELDS = [
  '#form-prestamo input[name="loanDate"]',
];

/**
 * Pone la fecha de hoy en los campos que estén vacíos o que todavía
 * tengan la fecha de ayer (porque nadie la cambió a mano).
 */
function fillTodayDates(today, previous = '') {
  for (const selector of TODAY_FIELDS) {
    const input = document.querySelector(selector);
    if (input && (input.value === '' || input.value === previous)) {
      input.value = today;
    }
  }
}

/* =========================================================
   4. ARRANQUE
   ========================================================= */

function init() {
  initTheme();
  initNavigation();
  initSwipe();
  initMoneyInputs();
  initCalendar();
  initTransactions();
  initDebts();
  initLoans();
  initExport();
  initHome();

  fillTodayDates(activeDate());
  // Si cambia el día real (medianoche) o eliges otro día en el calendario,
  // la "Fecha del préstamo" se actualiza (si no la habías cambiado a mano)
  onDayChange((_today, previous) => fillTodayDates(activeDate(), previous));
  onActiveDateChange((active, previous) => fillTodayDates(active, previous));

  // Le pide al teléfono que proteja los datos guardados
  requestPersistence();

  // Modo sin internet y avisos de versión nueva (si falla, la app sigue funcionando normal)
  initPwa().catch((error) => console.error('Error al iniciar el modo sin internet:', error));

  // La app ya está lista: se quita la pantalla de carga
  hideSplash();
}

init();