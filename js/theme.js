/* =========================================================
   theme.js
   Modo claro / oscuro.
   - La primera vez que abres la app te pregunta cuál prefieres.
   - Tu elección se guarda en el teléfono y ya no se vuelve a preguntar.
   - Después se cambia en Ajustes (el engrane de la pantalla de Inicio).
   ========================================================= */

import { getTheme, setTheme } from './storage.js';
import { el } from './utils.js';

const BAR_COLORS = { light: '#f5f7fb', dark: '#0f1420' }; // color de la barra del teléfono

/** Pone el tema en pantalla (no lo guarda). */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', BAR_COLORS[theme]);
}

/** El tema que se ve ahora: 'light' o 'dark'. */
export function getCurrentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Cambia el tema y lo guarda. */
export function chooseTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return;
  applyTheme(theme);
  setTheme(theme); // si el navegador no deja guardar, el cambio vale solo por esta sesión
}

function systemPrefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Ventanita de la primera vez. No se puede cerrar sin elegir. */
function askTheme() {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.setAttribute('aria-labelledby', 'theme-dialog-title');

  const form = document.createElement('form');
  form.noValidate = true;
  form.addEventListener('submit', (event) => event.preventDefault());

  const title = el('h2', '¿Qué modo prefieres?');
  title.id = 'theme-dialog-title';
  form.appendChild(title);
  form.appendChild(el('p', 'Después lo puedes cambiar en Ajustes (el engrane de arriba, en Inicio).', 'card__total'));

  for (const [theme, label] of [['light', 'Modo claro'], ['dark', 'Modo oscuro']]) {
    const button = el('button', label, 'btn-secondary');
    button.type = 'button';
    button.addEventListener('click', () => {
      chooseTheme(theme);
      dialog.close();
    });
    form.appendChild(button);
  }

  dialog.appendChild(form);
  // Con la tecla Escape no se cierra: así siempre queda una elección guardada
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  dialog.addEventListener('close', () => dialog.remove());

  document.body.appendChild(dialog);
  dialog.showModal();
}

export function initTheme() {
  const saved = getTheme();

  if (saved) {
    applyTheme(saved);
  } else {
    // Mientras eliges, se ve el modo que usa tu teléfono (sin guardarlo)
    applyTheme(systemPrefersDark() ? 'dark' : 'light');
    askTheme();
  }
}
