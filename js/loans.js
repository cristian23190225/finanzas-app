/* =========================================================
   loans.js
   Todo lo de Préstamos (dinero que TÚ le prestaste a alguien):
     1. El recuadro de Inicio (registrar un préstamo).
     2. La pantalla "Préstamos": una tarjeta por préstamo,
        cobro de intereses, cobro de capital (total o parcial)
        y cierre automático cuando te devuelven todo.

   CÓMO SE CALCULA EL INTERÉS:
     El interés de cada periodo es un porcentaje del capital que
     TODAVÍA te deben. Si te devuelven una parte del capital, el
     interés por cobro baja.
   ========================================================= */

import { activeDate } from './calendar.js';
import { addItem, getItems, removeItem, updateItem } from './storage.js';
import { getAvailableIncome, hasEnoughIncome, notEnoughIncomeMessage, updateDisplays } from './transactions.js';
import { showToast } from './ui.js';
import {
  FREQUENCIES,
  addPeriods,
  clear,
  cleanText,
  countDue,
  daysBetween,
  el,
  formatMoney,
  formatShortDate,
  isValidISODate,
  parseAmount,
  parsePercent,
  roundMoney,
  todayISO,
} from './utils.js';

// Por debajo de 1 centavo consideramos que ya no te deben nada
const EPS = 0.01;



// Cómo se dice cada frecuencia dentro de una frase
const FREQUENCY_PHRASE = {
  semanal: 'cada semana',
  quincenal: 'cada quincena',
  mensual: 'cada mes',
};

/** Interés que se cobra en cada periodo: 2000 al 10% = 200. */
export function interestPerPeriod(amount, rate) {
  return roundMoney((amount * rate) / 100);
}

/* =========================================================
   1. CÁLCULOS
   ========================================================= */

/** Datos calculados de un préstamo: capital que te deben, intereses y cuándo toca cobrar. */
export function describeLoan(loan, today = todayISO()) {
  const recovered = roundMoney(loan.principalPayments.reduce((sum, p) => sum + p.amount, 0));
  const outstanding = roundMoney(Math.max(0, loan.amount - recovered));
  const interestCollected = roundMoney(loan.interestPayments.reduce((sum, p) => sum + p.amount, 0));

  let nextDue = '';
  let pending = 0;
  let interestNext = 0;
  if (loan.hasInterest) {
    nextDue = addPeriods(loan.firstPaymentDate, loan.frequency, loan.interestPayments.length);
    // Cobros que ya vencieron y todavía no marcas
    pending = Math.max(0, countDue(loan.firstPaymentDate, loan.frequency, today) - loan.interestPayments.length);
    // Interés del próximo cobro: sobre el capital que todavía te deben (mínimo 1 centavo)
    if (outstanding > 0) interestNext = Math.max(0.01, interestPerPeriod(outstanding, loan.rate));
  }

  return { recovered, outstanding, interestCollected, nextDue, pending, interestNext };
}

/* =========================================================
   2. CAMPOS DE INTERÉS (mostrar/ocultar y vista previa)
   ========================================================= */

/** Muestra u oculta los campos de interés según la casilla. */
function syncInterestFields(form) {
  const checkbox = form.elements.hasInterest;
  const fields = document.getElementById('loan-interest-fields');
  if (!fields) return;

  fields.hidden = !checkbox.checked;
  // El porcentaje solo es obligatorio cuando se cobra interés
  form.elements.rate.required = checkbox.checked;
  updatePreview(form);
}

/** Texto que dice cuánto cobrarás, se actualiza mientras escribes. */
function updatePreview(form) {
  const preview = document.getElementById('loan-interest-preview');
  if (!preview) return;

  const amount = parseAmount(String(form.elements.amount.value));
  const rate = parsePercent(String(form.elements.rate.value));
  const frequency = String(form.elements.frequency.value);

  if (amount === null || rate === null || !FREQUENCIES.includes(frequency)) {
    preview.textContent = 'Escribe cuánto prestaste y el porcentaje para ver cuánto cobrarás.';
    return;
  }
  const interest = interestPerPeriod(amount, rate);
  preview.textContent = `Te pagará ${formatMoney(interest)} de interés ${FREQUENCY_PHRASE[frequency]}.`;
}

/* =========================================================
   3. REGISTRAR UN PRÉSTAMO (recuadro de Inicio)
   ========================================================= */

function handleSubmit(event) {
  event.preventDefault(); // evita que el navegador recargue la página
  const form = event.currentTarget;
  const formData = new FormData(form);

  const person = cleanText(String(formData.get('person') ?? ''), 60);
  if (person === '') {
    showToast('Escribe a quién le prestaste.', 'error');
    return;
  }

  const amount = parseAmount(String(formData.get('amount') ?? ''));
  if (amount === null) {
    showToast('Escribe cuánto prestaste (mayor a 0).', 'error');
    return;
  }

  const loanDate = String(formData.get('loanDate') ?? '');
  if (!isValidISODate(loanDate)) {
    showToast('Elige la fecha del préstamo.', 'error');
    return;
  }
  if (loanDate > todayISO()) {
    showToast('La fecha del préstamo no puede ser futura.', 'error');
    return;
  }

  // ¿Ese dinero sale de tus ingresos? (una casilla marcada llega como "on")
  const fromIncome = formData.get('fromIncome') === 'on';
  if (fromIncome && !hasEnoughIncome(amount)) {
    showToast(notEnoughIncomeMessage(true), 'error');
    return;
  }

  const hasInterest = formData.get('hasInterest') === 'on';
  let rate = 0;
  let frequency = '';
  let firstPaymentDate = '';

  if (hasInterest) {
    rate = parsePercent(String(formData.get('rate') ?? ''));
    if (rate === null) {
      showToast('Escribe el porcentaje de interés (entre 0.01 y 100).', 'error');
      return;
    }

    frequency = String(formData.get('frequency') ?? '');
    if (!FREQUENCIES.includes(frequency)) {
      showToast('Elige cada cuánto cobras el interés.', 'error');
      return;
    }

    if (interestPerPeriod(amount, rate) < 0.01) {
      showToast('Ese interés es menor a un centavo. Revisa la cantidad y el porcentaje.', 'error');
      return;
    }

    // Vacío = se calcula solo (fecha del préstamo + un periodo)
    firstPaymentDate = String(formData.get('firstPayment') ?? '');
    if (firstPaymentDate !== '') {
      if (!isValidISODate(firstPaymentDate)) {
        showToast('La fecha del primer cobro no es válida.', 'error');
        return;
      }
      if (firstPaymentDate < loanDate) {
        showToast('El primer cobro no puede ser antes de la fecha del préstamo.', 'error');
        return;
      }
    }
  }

  const saved = addItem('loans', {
    person,
    amount,
    date: loanDate,
    hasInterest,
    rate,
    frequency,
    firstPaymentDate,
  });
  if (!saved) {
    showToast('No se pudo guardar. Revisa el espacio de tu teléfono.', 'error');
    return;
  }

  // Si el dinero sale de tus ingresos, se anota como movimiento (con la fecha de hoy)
  if (fromIncome) {
    const movement = addItem('transactions', {
      type: 'prestamo',
      amount,
      note: person,
      date: activeDate(),
      fromIncome: true,
    });
    if (!movement) {
      removeItem('loans', saved.id); // deshacer el préstamo
      showToast('No se pudo guardar. Revisa el espacio de tu teléfono.', 'error');
      return;
    }
    updateDisplays();
  }

  // Dejar el formulario listo para el siguiente préstamo
  form.reset();
  form.elements.loanDate.value = activeDate(); // reset() la deja vacía; la volvemos a poner
  syncInterestFields(form);                  // reset() no avisa a la casilla, lo hacemos a mano

  let message = `Préstamo agregado: ${person}, ${formatMoney(amount)}`;
  message += fromIncome ? ' (restado de tus ingresos).' : '.';
  if (hasInterest) {
    message += ` Cobrarás ${formatMoney(interestPerPeriod(amount, rate))} ${FREQUENCY_PHRASE[frequency]}.`;
  }
  showToast(message);
}

/* =========================================================
   4. COBRAR INTERÉS / ELIMINAR
   ========================================================= */

/** Botones de selección "¿A dónde va este dinero?" (ingresos, ahorros o ninguno). */
function destinationField(defaultToIncome) {
  const field = document.createElement('fieldset');
  field.className = 'choice-group';

  const legend = document.createElement('legend');
  legend.textContent = '¿A dónde va este dinero?';
  field.appendChild(legend);

  const defaultValue = defaultToIncome ? 'income' : 'none';
  for (const [value, text] of [
    ['income', 'Sumar a mis ingresos'],
    ['savings', 'Agregar a mis ahorros'],
    ['none', 'No sumarlo a ninguno'],
  ]) {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'destination';
    input.value = value;
    input.checked = value === defaultValue;
    label.append(input, el('span', text));
    field.appendChild(label);
  }

  return {
    field,
    // Devuelve 'income', 'savings' o 'none' según el botón elegido
    getValue: () => field.querySelector('input:checked')?.value ?? 'none',
  };
}

function openInterestDialog(loan, container, defaultToIncome) {
  const info = describeLoan(loan);
  if (!loan.hasInterest || info.outstanding <= 0) return;

  const { dialog, form } = createDialog();

  form.appendChild(el('h2', `Cobrar interés: ${loan.person}`));

  let intro = `Te debe ${formatMoney(info.outstanding)} y le cobras ${loan.rate}% ${FREQUENCY_PHRASE[loan.frequency]}.`;
  if (info.pending > 1) {
    intro += ` Tienes ${info.pending} cobros vencidos: se marcan de uno en uno.`;
  }
  form.appendChild(el('p', intro, 'card__total'));
  form.appendChild(el('p', `Vas a cobrar ${formatMoney(info.interestNext)} de interés.`, 'interest-preview'));

  const dest = destinationField(defaultToIncome);

  const errorBox = el('p', '', 'dialog__error');
  errorBox.setAttribute('role', 'alert');

  const saveButton = el('button', 'Guardar cobro');
  saveButton.type = 'submit';
  const cancelButton = el('button', 'Cancelar', 'btn-secondary');
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', () => dialog.close());

  form.append(dest.field, errorBox, saveButton, cancelButton);

  const fail = (message) => {
    errorBox.textContent = message;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const amount = info.interestNext;
    const toIncome = dest.getValue() === 'income';
    const toSavings = dest.getValue() === 'savings';
    const today = activeDate(); // hoy, o el día pasado que elegiste en el calendario

    // 1) Movimiento del cobro en el historial
    const movement = addItem('transactions', {
      type: 'cobro_interes',
      amount,
      note: loan.person,
      date: today,
      fromIncome: toIncome, // solo suma a ingresos si elegiste "ingresos"
    });
    if (!movement) return fail('No se pudo guardar. Revisa el espacio de tu teléfono.');

    // 2) Si va a ahorros, se registra un ahorro (sin restar de ingresos)
    let savingMovement = null;
    if (toSavings) {
      savingMovement = addItem('transactions', {
        type: 'ahorro',
        amount,
        note: `Interés de préstamo: ${loan.person}`,
        date: today,
        fromIncome: false,
      });
      if (!savingMovement) {
        removeItem('transactions', movement.id); // deshacer el paso 1
        return fail('No se pudo guardar. Revisa el espacio de tu teléfono.');
      }
    }

    // 3) Se anota el cobro en el préstamo
    const saved = updateItem('loans', loan.id, {
      interestPayments: [...loan.interestPayments, { date: today, amount, kind: 'regular' }],
    });
    if (saved === null) {
      removeItem('transactions', movement.id); // deshacer los pasos anteriores
      if (savingMovement) removeItem('transactions', savingMovement.id);
      return fail('No se pudo guardar el cobro. Intenta de nuevo.');
    }

    dialog.close();
    updateDisplays();
    renderLoans(container);

    let note = '';
    if (toIncome) note = ' (sumado a tus ingresos)';
    else if (toSavings) note = ' (agregado a tus ahorros)';
    showToast(`Interés cobrado: ${formatMoney(amount)}${note}.`);
  });

  document.body.appendChild(dialog);
  dialog.showModal();
}

function deleteLoan(loan, container) {
  const ok = window.confirm(
    `¿Eliminar el préstamo de "${loan.person}"? Los cobros que ya marcaste se conservan en tu historial.`
  );
  if (!ok) return;

  if (!removeItem('loans', loan.id)) {
    showToast('No se pudo eliminar. Intenta de nuevo.', 'error');
    return;
  }
  renderLoans(container);
  showToast('Préstamo eliminado.');
}

/* =========================================================
   5. COBRAR CAPITAL (ventanita)
   ========================================================= */

/** Crea una ventanita vacía que se elimina del documento al cerrarse. */
function createDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  const form = document.createElement('form');
  form.noValidate = true; // los errores se muestran dentro de la ventanita
  dialog.appendChild(form);
  dialog.addEventListener('close', () => dialog.remove());
  return { dialog, form };
}

function openPrincipalDialog(loan, container, defaultToIncome) {
  const info = describeLoan(loan);
  if (info.outstanding <= 0) return;

  const { dialog, form } = createDialog();

  form.appendChild(el('h2', `Cobrar capital: ${loan.person}`));
  form.appendChild(
    el('p', `Te debe ${formatMoney(info.outstanding)} de los ${formatMoney(loan.amount)} que le prestaste.`, 'card__total')
  );

  // Campo de cantidad (empieza con todo lo que te deben)
  const amountLabel = document.createElement('label');
  amountLabel.appendChild(document.createTextNode('¿Cuánto te devolvió?'));
  const amountInput = document.createElement('input');
  amountInput.name = 'amount';
  amountInput.type = 'number';
  amountInput.inputMode = 'decimal';
  amountInput.min = '0.01';
  amountInput.step = '0.01';
  amountInput.value = String(info.outstanding);
  amountLabel.appendChild(amountInput);

  const preview = el('p', '', 'interest-preview');

  // ¿A dónde va el dinero? ingresos, ahorros o a ninguno
  const dest = destinationField(defaultToIncome);

  const errorBox = el('p', '', 'dialog__error');
  errorBox.setAttribute('role', 'alert');

  const saveButton = el('button', 'Guardar cobro');
  saveButton.type = 'submit';
  const cancelButton = el('button', 'Cancelar', 'btn-secondary');
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', () => dialog.close());

  form.append(amountLabel, preview, dest.field, errorBox, saveButton, cancelButton);

  function updatePreview() {
    errorBox.textContent = '';
    const amount = parseAmount(amountInput.value);
    if (amount === null) {
      preview.textContent = 'Escribe cuánto te devolvió.';
      return;
    }
    if (amount > info.outstanding + EPS) {
      preview.textContent = `No puede ser más de lo que te debe (${formatMoney(info.outstanding)}).`;
      return;
    }
    const left = roundMoney(info.outstanding - amount);
    if (left < EPS) {
      let text = 'Con esto termina el préstamo.';
      if (loan.hasInterest && info.pending > 0) {
        text += ` Tienes ${info.pending} cobro${info.pending === 1 ? '' : 's'} de interés sin marcar: se descartan al cerrar.`;
      }
      preview.textContent = text;
    } else {
      let text = `Te seguirá debiendo ${formatMoney(left)}.`;
      if (loan.hasInterest) {
        text += ` Tu interés bajará a ${formatMoney(interestPerPeriod(left, loan.rate))} ${FREQUENCY_PHRASE[loan.frequency]}.`;
      }
      preview.textContent = text;
    }
  }
  amountInput.addEventListener('input', updatePreview);
  updatePreview();

  const fail = (message) => {
    errorBox.textContent = message;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const amount = parseAmount(amountInput.value);
    if (amount === null) return fail('Escribe cuánto te devolvió (mayor a 0).');
    if (amount > info.outstanding + EPS) {
      return fail(`No puede ser más de lo que te debe (${formatMoney(info.outstanding)}).`);
    }

    const left = roundMoney(info.outstanding - amount);
    const isFinished = left < EPS;
    const destination = dest.getValue();
    const toIncome = destination === 'income';
    const toSavings = destination === 'savings';
    const today = activeDate(); // hoy, o el día pasado que elegiste en el calendario

    // 1) Movimiento del cobro en el historial
    const movement = addItem('transactions', {
      type: 'cobro_prestamo',
      amount,
      note: loan.person,
      date: today,
      fromIncome: toIncome, // solo suma a ingresos si elegiste "ingresos"
    });
    if (!movement) return fail('No se pudo guardar. Revisa el espacio de tu teléfono.');

    // 2) Si va a ahorros, se registra un ahorro (sin restar de ingresos: ese dinero nunca pasó por ahí)
    let savingMovement = null;
    if (toSavings) {
      savingMovement = addItem('transactions', {
        type: 'ahorro',
        amount,
        note: `Cobro de préstamo: ${loan.person}`,
        date: today,
        fromIncome: false,
      });
      if (!savingMovement) {
        removeItem('transactions', movement.id); // deshacer el paso 1
        return fail('No se pudo guardar. Revisa el espacio de tu teléfono.');
      }
    }

    // 3) Se anota en el préstamo, o se elimina si te devolvieron todo
    const saved = isFinished
      ? removeItem('loans', loan.id)
      : updateItem('loans', loan.id, {
          principalPayments: [...loan.principalPayments, { date: today, amount, kind: 'regular' }],
        }) !== null;

    if (!saved) {
      removeItem('transactions', movement.id); // deshacer los pasos anteriores
      if (savingMovement) removeItem('transactions', savingMovement.id);
      return fail('No se pudo guardar el cobro. Intenta de nuevo.');
    }

    dialog.close();
    updateDisplays();
    renderLoans(container);

    let note = '';
    if (toIncome) note = ' (sumado a tus ingresos)';
    else if (toSavings) note = ' (agregado a tus ahorros)';

    if (isFinished) {
      showToast(`¡Préstamo cobrado: ${loan.person}! Te devolvió ${formatMoney(amount)}${note}.`);
    } else {
      showToast(`Cobro de capital: ${formatMoney(amount)}${note}. Todavía te debe ${formatMoney(left)}.`);
    }
  });

  document.body.appendChild(dialog);
  dialog.showModal();
  amountInput.focus();
  amountInput.select();
}

/* =========================================================
   6. PANTALLA "PRÉSTAMOS" (una tarjeta por préstamo)
   ========================================================= */

/** Etiqueta de estado según cuándo toca cobrar. */
function statusBadge(loan, info, today) {
  if (!loan.hasInterest) return el('span', 'Sin interés', 'badge');

  const days = daysBetween(today, info.nextDue);
  if (days < 0) {
    const late = -days;
    let text = `Cobro vencido hace ${late} día${late === 1 ? '' : 's'}`;
    if (info.pending > 1) text += ` · ${info.pending} cobros pendientes`;
    return el('span', text, 'badge badge--late');
  }
  if (days === 0) return el('span', 'Toca cobrar hoy', 'badge badge--today');
  return el('span', `Faltan ${days} día${days === 1 ? '' : 's'}`, 'badge');
}

/**
 * Crea un dato de la tarjeta con su etiqueta (data-label).
 * El CSS muestra la etiqueta arriba y el valor debajo.
 */
function cell(label, content, className = '') {
  const td = el('td', content, className);
  td.setAttribute('data-label', label);
  return td;
}

function buildRow(loan, info, today, container) {
  const row = document.createElement('tr');

  // Arriba de la tarjeta: nombre y estado
  const titleCell = el('td', '', 'cell-title');
  titleCell.appendChild(el('span', loan.person, 'cell-title__name'));
  titleCell.appendChild(statusBadge(loan, info, today));
  row.appendChild(titleCell);

  row.appendChild(cell('Me debe', formatMoney(info.outstanding), 'num cell-credit'));
  row.appendChild(cell('Prestado', formatMoney(loan.amount), 'num'));
  row.appendChild(cell('Fecha del préstamo', formatShortDate(loan.date)));

  if (info.recovered > 0) {
    row.appendChild(cell('Capital recuperado', formatMoney(info.recovered), 'num'));
  }

  if (loan.hasInterest) {
    row.appendChild(cell('Interés', `${loan.rate}% ${FREQUENCY_PHRASE[loan.frequency]}`));
    row.appendChild(cell('Interés por cobro', formatMoney(info.interestNext), 'num cell-credit'));
    row.appendChild(cell('Próximo cobro', formatShortDate(info.nextDue)));
    row.appendChild(cell('Intereses cobrados', formatMoney(info.interestCollected), 'num'));
  }

  const actions = el('td', '', 'actions');

  if (loan.hasInterest) {
    const interestButton = el('button', 'Cobré el interés', 'btn-small');
    interestButton.type = 'button';
    interestButton.addEventListener('click', () => openInterestDialog(loan, container, true));
    actions.appendChild(interestButton);
  }

  const principalButton = el(
    'button',
    'Cobré capital',
    loan.hasInterest ? 'btn-small btn-small--outline' : 'btn-small'
  );
  principalButton.type = 'button';
  principalButton.addEventListener('click', () => openPrincipalDialog(loan, container, true));

  const deleteButton = el('button', 'Eliminar', 'btn-small btn-small--ghost');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteLoan(loan, container));

  actions.append(principalButton, deleteButton);
  row.appendChild(actions);

  return row;
}

/** Dibuja la pantalla de Préstamos dentro de su contenedor. */
export function renderLoans(container) {
  clear(container);
  const today = todayISO();

  // Los cobros más cercanos primero; los préstamos sin interés al final
  const rows = getItems('loans')
    .map((loan) => ({ loan, info: describeLoan(loan, today) }))
    .sort((a, b) => {
      const keyA = a.info.nextDue || '9999-99-99';
      const keyB = b.info.nextDue || '9999-99-99';
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });

  // Tarjeta de arriba: préstamos a la izquierda, ingresos a la derecha
  const summary = el('section', '', 'card');

  if (rows.length === 0) {
    summary.appendChild(el('h2', 'Mis préstamos'));
    summary.appendChild(el('p', 'No tienes préstamos registrados.', 'card__total'));
    container.appendChild(summary);
    return;
  }

  const top = el('div', '', 'debts-top');

  // Lado izquierdo: cuánto te deben
  const loansSide = el('div', '', 'debts-top__side');
  loansSide.appendChild(el('h2', 'Mis préstamos'));
  const totalOutstanding = roundMoney(rows.reduce((sum, r) => sum + r.info.outstanding, 0));
  const totalLine = el('p', 'Me deben en total: ', 'card__total');
  totalLine.appendChild(el('strong', formatMoney(totalOutstanding)));
  loansSide.appendChild(totalLine);

  // Intereses que ya debieron pagarte y todavía no marcas
  const overdueInterest = roundMoney(rows.reduce((sum, r) => sum + r.info.pending * r.info.interestNext, 0));
  if (overdueInterest > 0) {
    const overdueLine = el('p', 'Intereses vencidos: ', 'card__total');
    overdueLine.appendChild(el('strong', formatMoney(overdueInterest)));
    loansSide.appendChild(overdueLine);
  }

  // Lado derecho: Mis ingresos
  const incomeSide = el('div', '', 'debts-top__side');
  incomeSide.appendChild(el('h2', 'Mis ingresos'));
  const incomeLine = el('p', 'Disponible: ', 'card__total');
  incomeLine.appendChild(el('strong', formatMoney(getAvailableIncome())));
  incomeSide.appendChild(incomeLine);

  top.append(loansSide, incomeSide);
  summary.appendChild(top);
  container.appendChild(summary);

  // Una tarjeta por préstamo (el CSS las acomoda según el ancho de la pantalla)
  const card = el('section', '', 'card');
  const wrap = el('div', '', 'table-wrap');
  const table = el('table', '', 'table');

  const tbody = document.createElement('tbody');
  for (const { loan, info } of rows) {
    tbody.appendChild(buildRow(loan, info, today, container));
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  container.appendChild(card);
}

/* =========================================================
   7. ARRANQUE
   ========================================================= */

export function initLoans() {
  const form = document.getElementById('form-prestamo');
  if (!form) return;

  form.addEventListener('submit', handleSubmit);
  form.elements.hasInterest.addEventListener('change', () => syncInterestFields(form));

  // La vista previa se recalcula mientras escribes
  for (const name of ['amount', 'rate', 'frequency']) {
    form.elements[name].addEventListener('input', () => updatePreview(form));
  }

  syncInterestFields(form); // estado inicial: campos de interés ocultos
}