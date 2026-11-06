/* =========================================================
   settings.js
   Pantalla de Ajustes (se abre con el engrane de Inicio).
   Por ahora: elegir modo claro u oscuro. Aquí caben más
   opciones después (respaldo, etc.).
   ========================================================= */

import { chooseTheme, getCurrentTheme } from './theme.js';
import { clear, el } from './utils.js';

const THEME_OPTIONS = [
  ['light', 'Modo claro'],
  ['dark', 'Modo oscuro'],
];

export function renderSettings(container) {
  clear(container);

  const card = el('section', '', 'card');
  card.appendChild(el('h2', 'Ajustes'));

  const group = el('fieldset', '', 'choice-group');
  group.appendChild(el('legend', 'Apariencia'));

  const current = getCurrentTheme();
  for (const [theme, label] of THEME_OPTIONS) {
    const row = el('label', '', 'choice');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'theme';
    input.value = theme;
    input.checked = theme === current;
    input.addEventListener('change', () => {
      if (input.checked) chooseTheme(theme); // se aplica y se guarda al instante
    });
    row.appendChild(input);
    row.appendChild(el('span', label));
    group.appendChild(row);
  }
  card.appendChild(group);
  container.appendChild(card);

  const back = el('button', '← Volver a Inicio', 'btn-secondary');
  back.type = 'button';
  back.addEventListener('click', () => {
    document.querySelector('.nav__btn[data-view="inicio"]')?.click();
  });
  container.appendChild(back);
}
