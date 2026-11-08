/* =========================================================
   money-input.js
   Pone comas de miles mientras se escribe una cantidad:
   50000 -> 50,000. Funciona en todos los cuadros marcados con
   data-money (los de los formularios y los de las ventanas).
   Al guardar, utils.parseAmount() ignora las comas.
   ========================================================= */

import { formatAmountText } from './utils.js';

/** Vuelve a escribir el cuadro con comas, sin mover el cursor de lugar. */
function reformat(input) {
  const before = input.value;
  const caret = input.selectionStart ?? before.length;

  // Cuántos números y puntos había antes del cursor
  const significant = before.slice(0, caret).replace(/[^0-9.]/g, '').length;

  const formatted = formatAmountText(before);
  if (formatted === before) return;
  input.value = formatted;

  // El cursor se coloca después de esa misma cantidad de números y puntos
  let position = 0;
  let seen = 0;
  while (position < formatted.length && seen < significant) {
    if (formatted[position] !== ',') seen++;
    position++;
  }
  try {
    input.setSelectionRange(position, position);
  } catch {
    /* algunos navegadores no permiten mover el cursor; no pasa nada */
  }
}

export function initMoneyInputs() {
  // Un solo aviso para toda la página: también cubre los cuadros que se crean después
  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target && typeof target.matches === 'function' && target.matches('input[data-money]')) reformat(target);
  });
}
