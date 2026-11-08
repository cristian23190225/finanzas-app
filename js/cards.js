/* =========================================================
   cards.js
   Piezas de pantalla que comparten Deudas y Préstamos:
   encabezado con botón "Agregar", panel marino, barra de progreso,
   cuadrícula de datos y mensaje de "todavía no hay nada".
   Solo dibuja: no guarda ni cambia datos.
   ========================================================= */

import { el } from './utils.js';

/**
 * Lleva a Inicio y abre la hoja de ese formulario (por ejemplo "sheet-deuda").
 * Los dos avisos los escuchan main.js (cambiar de pantalla) y home.js (abrir la hoja).
 */
export function openAddSheet(sheetId) {
  document.dispatchEvent(new CustomEvent('finanzas:ver', { detail: 'inicio' }));
  document.dispatchEvent(new CustomEvent('finanzas:abrir-hoja', { detail: sheetId }));
}

/** Encabezado de la pantalla: título a la izquierda y botón "+ Agregar" a la derecha. */
export function buildViewHeader(title, addLabel, sheetId) {
  const header = el('header', '', 'home-header');
  header.appendChild(el('h1', title, 'home-header__title'));

  const add = el('button', `+ ${addLabel}`, 'btn-small');
  add.type = 'button';
  add.addEventListener('click', () => openAddSheet(sheetId));
  header.appendChild(add);
  return header;
}

/**
 * Panel marino (igual al de Inicio y Resumen).
 * meta = [{ label, value, tone }], tone: '' | 'is-in' | 'is-out'
 */
export function buildHero(label, amountText, meta) {
  const hero = el('section', '', 'balance');
  hero.setAttribute('aria-label', label);
  hero.appendChild(el('p', label, 'balance__label'));
  hero.appendChild(el('p', amountText, 'balance__amount'));

  const list = el('dl', '', 'balance__meta balance__meta--3');
  for (const { label: name, value, tone } of meta) {
    const box = el('div');
    box.append(el('dt', name), el('dd', value, tone || ''));
    list.appendChild(box);
  }
  hero.appendChild(list);
  return hero;
}

/** Barra de progreso. ratio va de 0 a 1; text es lo que se lee debajo. */
export function buildProgress(ratio, text) {
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const percent = Math.round(safe * 100);

  const wrap = el('div');
  const track = el('div', '', 'progress');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(percent));
  track.setAttribute('aria-label', text);

  const fill = el('div', '', 'progress__fill');
  fill.style.transform = `scaleX(${safe})`;
  track.appendChild(fill);

  wrap.append(track, el('p', `${text} · ${percent}%`, 'progress__text'));
  return wrap;
}

/** Cuadrícula de datos: [[etiqueta, valor], ...] en dos columnas. */
export function buildStats(pairs) {
  const list = el('dl', '', 'stats');
  for (const [label, value] of pairs) {
    const box = el('div');
    box.append(el('dt', label), el('dd', value));
    list.appendChild(box);
  }
  return list;
}

/** Mensaje cuando todavía no hay nada, con botón para agregar el primero. */
export function buildEmpty(title, text, buttonLabel, sheetId) {
  const box = el('section', '', 'empty-state');
  box.append(el('h2', title, 'empty-state__title'), el('p', text, 'empty-state__text'));

  const button = el('button', `+ ${buttonLabel}`, 'btn-small btn-block');
  button.type = 'button';
  button.addEventListener('click', () => openAddSheet(sheetId));
  box.appendChild(button);
  return box;
}
