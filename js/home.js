/* =========================================================
   home.js
   La pantalla de Inicio:
     - Hojas inferiores: cada botón (Ingreso, Gasto...) abre su formulario
       en una hoja que sube desde abajo, y se cierra al guardar.
     - Saldo del panel: el número se anima cuando cambia.
     - Pantalla de carga: se muestra al abrir la app y se desvanece.
   Los formularios y sus reglas siguen en transactions.js, debts.js y loans.js.
   ========================================================= */

import { formatMoney, roundMoney } from './utils.js';

const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* =========================================================
   1. HOJAS INFERIORES
   ========================================================= */

const CLOSE_FALLBACK_MS = 320; // por si la animación de cierre no avisa que terminó

/** Abre una hoja y pone el cursor en su primer campo (así sale el teclado de una vez). */
function openSheet(id) {
  const dialog = document.getElementById(id);
  if (!dialog || typeof dialog.showModal !== 'function' || dialog.open) return;

  dialog.classList.remove('is-closing');
  dialog.showModal();

  const firstField = dialog.querySelector('input:not([type="checkbox"]):not([type="hidden"]), select, textarea');
  if (firstField) firstField.focus({ preventScroll: true });
}

/** Cierra una hoja con una pequeña animación hacia abajo. */
function closeSheet(dialog) {
  if (!dialog || !dialog.open || dialog.classList.contains('is-closing')) return;

  if (reduceMotion()) {
    dialog.close();
    return;
  }

  dialog.classList.add('is-closing');
  const finish = () => {
    dialog.classList.remove('is-closing');
    if (dialog.open) dialog.close();
  };
  dialog.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, CLOSE_FALLBACK_MS);
}

function initSheets() {
  // Botones que abren una hoja: <button data-open-sheet="sheet-gasto">
  for (const button of document.querySelectorAll('[data-open-sheet]')) {
    button.addEventListener('click', () => openSheet(button.dataset.openSheet));
  }

  for (const dialog of document.querySelectorAll('dialog.sheet')) {
    // Botón "×"
    for (const close of dialog.querySelectorAll('[data-close-sheet]')) {
      close.addEventListener('click', () => closeSheet(dialog));
    }
    // Tocar fuera de la hoja (el fondo oscuro)
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeSheet(dialog);
    });
    // Tecla Escape o gesto de cerrar del sistema: con animación
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeSheet(dialog);
    });
    // Al guardar, el formulario se limpia (reset): ahí se cierra la hoja
    for (const form of dialog.querySelectorAll('form')) {
      form.addEventListener('reset', () => closeSheet(dialog));
    }
  }

  // Al elegir un día en el calendario, la hoja del calendario se cierra sola
  document.addEventListener('finanzas:dia-elegido', () => {
    closeSheet(document.getElementById('sheet-calendario'));
  });
}

/* =========================================================
   2. SALDO ANIMADO
   ========================================================= */

const COUNT_MS = 450;

/** "-$1,000.00" -> -1000 */
function parseMoney(text) {
  const n = Number(String(text).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function initBalance() {
  const amount = document.getElementById('income-available');
  if (!amount || typeof MutationObserver === 'undefined') return;

  let shown = parseMoney(amount.textContent);
  let lastPainted = amount.textContent;
  let frame = 0;

  const paint = (value) => {
    shown = value;
    lastPainted = formatMoney(roundMoney(value));
    amount.textContent = lastPainted;
    amount.classList.toggle('is-negative', value < 0);
  };
  amount.classList.toggle('is-negative', shown < 0);

  const animateTo = (target) => {
    cancelAnimationFrame(frame);
    const from = shown;
    if (reduceMotion() || from === target) {
      paint(target);
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / COUNT_MS);
      paint(from + (target - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) frame = requestAnimationFrame(step);
      else paint(target);
    };
    frame = requestAnimationFrame(step);
  };

  // transactions.js escribe el saldo nuevo; aquí se detecta y se anima desde el anterior
  new MutationObserver(() => {
    const text = amount.textContent;
    if (text === lastPainted) return; // fue nuestro propio dibujo
    const target = parseMoney(text);
    amount.textContent = lastPainted; // se vuelve a mostrar el valor anterior antes de animar
    animateTo(target);
  }).observe(amount, { childList: true, characterData: true, subtree: true });
}

/* =========================================================
   3. PANTALLA DE CARGA
   ========================================================= */

const SPLASH_MIN_MS = 900; // tiempo mínimo en pantalla desde que empezó a cargar
const SPLASH_MIN_REDUCED_MS = 250;

/** Desvanece y quita la pantalla de carga (después de un mínimo, para que no parpadee). */
export function hideSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;

  const minimum = reduceMotion() ? SPLASH_MIN_REDUCED_MS : SPLASH_MIN_MS;
  const wait = Math.max(0, minimum - performance.now());

  setTimeout(() => {
    splash.classList.add('is-hiding');
    const remove = () => splash.remove();
    splash.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 600); // por si la transición no avisa
  }, wait);
}

/* =========================================================
   4. ARRANQUE
   ========================================================= */

export function initHome() {
  initSheets();
  initBalance();
}
