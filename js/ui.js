/* =========================================================
   ui.js
   Mensajes breves que aparecen abajo de la pantalla
   ("Ingreso agregado", errores, etc.). Lo usan todos los
   módulos para avisarte qué pasó.
   ========================================================= */

import { el } from './utils.js';

let toastElement = null;
let hideTimer = null;

/** Crea (una sola vez) el recuadro del mensaje. */
function ensureToast() {
  if (!toastElement) {
    toastElement = el('div', '', 'toast');
    // Los lectores de pantalla anuncian el texto cuando cambia
    toastElement.setAttribute('role', 'status');
    toastElement.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastElement);
  }
  return toastElement;
}

/**
 * Muestra un mensaje unos segundos.
 *   kind = 'ok'    -> aviso normal
 *   kind = 'error' -> aviso en rojo (dura un poco más)
 */
export function showToast(message, kind = 'ok') {
  const toast = ensureToast();
  // Si hay una hoja o ventana abierta, el aviso va DENTRO de ella (si no, quedaría tapado por detrás)
  const host = document.querySelector('dialog[open]') || document.body;
  if (toast.parentNode !== host) host.appendChild(toast);
  toast.textContent = message; // textContent: nunca se interpreta como HTML
  toast.classList.toggle('toast--error', kind === 'error');
  toast.classList.add('is-visible');

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => toast.classList.remove('is-visible'), kind === 'error' ? 4500 : 3000);
}

/**
 * Abre una ventana (hoja o diálogo) SIN poner el cursor en un campo:
 * así el teclado no sale solo y la persona puede leer primero.
 * El foco inicial se lo lleva el título de la ventana.
 */
export function showDialog(dialog) {
  const title = dialog.querySelector('h2');
  if (title) {
    title.tabIndex = -1;
    title.setAttribute('autofocus', '');
  }
  dialog.showModal();
}

// Se crea desde el inicio para que los lectores de pantalla ya lo conozcan
ensureToast();