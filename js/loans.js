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

   COBROS ATRASADOS Y ADELANTADOS (ver arrears.js):
     - "Interés del día" = el cobro del periodo más reciente. Al cobrarlo,
       el próximo cobro salta al siguiente periodo aunque haya atrasos.
     - "Interés atrasado" = dinero de cobros que no se hicieron. Cobrarlo
       NO mueve la fecha del próximo cobro.
     - Si te dan más del cobro estando al día, se adelantan periodos.
   ========================================================= */

import { buildEmpty, buildHero, buildProgress, buildStats, buildViewHeader } from './cards.js';
import { MAX_AHEAD, maxDayAmount, payDay, payLate, settle, view } from './arrears.js';
import { activeDate } from './calendar.js';
import { addItem, getItems, removeItem, updateItem } from './storage.js';
import { getAvailableIncome, hasEnoughIncome, notEnoughIncomeMessage, updateDisplays } from './transactions.js';
import { showDialog, showToast } from './ui.js';
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
  formatAmountText,
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

  const base = {
    recovered,
    outstanding,
    interestCollected,
    nextDue: '',
    pending: 0, // cobros por cobrar ya vencidos (atrasados + el del día)
    interestNext: 0, // interés de cada cobro
    interestOverdue: 0, // todo lo que ya debió pagarte: atrasado + el del día
    backlog: 0, // dinero de interés atrasado
    lateCount: 0, // cuántos cobros son (atrasado ÷ interés por cobro, hacia arriba)
    full: 0, // cobros completos dentro de lo atrasado
    rest: 0, // y el sobrante (un cobro más, de menos dinero)
    credit: 0, // dinero a favor por cobros adelantados
    dayOpen: false, // ¿el cobro del día todavía no se cobra?
    dayDue: 0, // cuánto toca del cobro del día
    ahead: 0, // periodos ya cobrados por adelantado
    overdueSince: '', // desde cuándo hay atraso (si se conoce)
  };
  if (!loan.hasInterest) return base;

  // Interés de cada cobro: sobre el capital que todavía te deben (mínimo 1 centavo)
  const interestNext = outstanding > 0 ? Math.max(0.01, interestPerPeriod(outstanding, loan.rate)) : 0;
  const state = { closed: loan.periodsClosed, backlog: loan.interestBacklog, credit: loan.interestCredit };

  if (interestNext === 0) {
    // Ya no te deben capital: solo puede quedar interés atrasado
    return { ...base, nextDue: addPeriods(loan.firstPaymentDate, loan.frequency, state.closed), backlog: state.backlog, interestOverdue: state.backlog };
  }

  const elapsed = countDue(loan.firstPaymentDate, loan.frequency, today); // periodos que ya vencieron
  const v = view(state, elapsed, interestNext);
  return {
    ...base,
    nextDue: addPeriods(loan.firstPaymentDate, loan.frequency, v.nextIndex),
    pending: v.lateCount + (v.dayDue > 0 ? 1 : 0),
    interestNext,
    interestOverdue: roundMoney(v.backlog + v.dayDue),
    backlog: v.backlog,
    lateCount: v.lateCount,
    full: v.full,
    rest: v.rest,
    credit: v.credit,
    dayOpen: v.dayOpen,
    dayDue: v.dayDue,
    ahead: v.ahead,
    overdueSince: v.oldestIndex === null ? '' : addPeriods(loan.firstPaymentDate, loan.frequency, v.oldestIndex),
  };
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

/** "cobro" o "cobros" según la cantidad. */
function plural(n, one, many) {
  return n === 1 ? one : many;
}

/** "3 de $200.00 + 1 de $150.00": de qué cobros se forma lo atrasado. */
function lateBreakdown(v, per) {
  const parts = [];
  if (v.full > 0) parts.push(`${v.full} de ${formatMoney(per)}`);
  if (v.rest > 0) parts.push(`1 de ${formatMoney(v.rest)}`);
  return parts.join(' + ');
}

/** Estado en el formato de arrears.js. */
function loanState(loan) {
  return { closed: loan.periodsClosed, backlog: loan.interestBacklog, credit: loan.interestCredit };
}

/**
 * Antes de bajar el capital, los cobros vencidos que no se cobraron pasan a "atrasado"
 * con el interés de ANTES (así no cambian de precio cuando baja el capital).
 */
function settledInterest(loan, info) {
  if (!loan.hasInterest || info.interestNext <= 0) return {};
  const s = settle(loanState(loan), countDue(loan.firstPaymentDate, loan.frequency, todayISO()), info.interestNext);
  return { periodsClosed: s.closed, interestBacklog: s.backlog, interestCredit: s.credit };
}

function openInterestDialog(loan, container, defaultToIncome) {
  if (!loan.hasInterest) return;
  const info = describeLoan(loan);
  if (info.outstanding <= 0) return;

  const per = info.interestNext;
  const elapsed = countDue(loan.firstPaymentDate, loan.frequency, todayISO()); // periodos que ya vencieron
  const state = loanState(loan);
  const maxDay = maxDayAmount(state, elapsed, per);
  const canDay = maxDay >= 0.01; // el del día, o adelantar el siguiente
  const canLate = info.backlog >= 0.01;
  if (!canDay && !canLate) {
    showToast('Este préstamo no tiene intereses por cobrar.');
    return;
  }

  // Lo que toca del cobro del día (o del siguiente, si el del día ya está cobrado)
  const dayDefault = info.dayOpen ? info.dayDue : roundMoney(Math.max(0.01, per - info.credit));
  let mode = canDay ? 'day' : 'late';
  const defaultFor = (m) => (m === 'day' ? dayDefault : info.backlog);
  const maxFor = (m) => (m === 'day' ? maxDay : info.backlog);

  const { dialog, form } = createDialog();
  form.appendChild(el('h2', `Cobrar interés: ${loan.person}`));

  const intro = [`Te debe ${formatMoney(info.outstanding)} y le cobras ${loan.rate}% ${FREQUENCY_PHRASE[loan.frequency]}: ${formatMoney(per)} por cobro.`];
  if (info.backlog > 0) {
    intro.push(`Atrasado: ${formatMoney(info.backlog)} (${info.lateCount} ${plural(info.lateCount, 'cobro', 'cobros')}: ${lateBreakdown(info, per)}).`);
  }
  if (!info.dayOpen && info.backlog <= 0) intro.push('Va al corriente: lo que cobres se adelanta al siguiente cobro.');
  if (info.ahead > 0) intro.push(`Va adelantado ${info.ahead} ${plural(info.ahead, 'cobro', 'cobros')}.`);
  if (info.credit > 0) intro.push(`Tiene ${formatMoney(info.credit)} a su favor.`);
  form.appendChild(el('p', intro.join(' '), 'card__total'));

  // ¿Qué cobraste? (solo si hay las dos opciones)
  const choice = document.createElement('fieldset');
  choice.className = 'choice-group';
  if (canDay && canLate) {
    choice.appendChild(el('legend', '¿Qué cobraste?'));
    const dayText = info.dayOpen
      ? `Interés del día · ${formatMoney(dayDefault)}`
      : `Interés del próximo cobro, por adelantado · ${formatMoney(dayDefault)}`;
    for (const [value, text] of [
      ['day', dayText],
      ['late', `Interés atrasado · ${formatMoney(info.backlog)}`],
    ]) {
      const label = document.createElement('label');
      label.className = 'choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'mode';
      input.value = value;
      input.checked = value === mode;
      input.addEventListener('change', () => {
        mode = value;
        amountInput.value = formatAmountText(String(defaultFor(mode)));
        updatePreview();
      });
      label.append(input, el('span', text));
      choice.appendChild(label);
    }
  } else {
    choice.hidden = true;
  }

  const amountLabel = document.createElement('label');
  amountLabel.appendChild(document.createTextNode('¿Cuánto te dio?'));
  const amountInput = document.createElement('input');
  amountInput.name = 'amount';
  amountInput.type = 'text';
  amountInput.inputMode = 'decimal';
  amountInput.setAttribute('data-money', '');
  amountInput.autocomplete = 'off';
  amountInput.value = formatAmountText(String(defaultFor(mode)));
  amountLabel.appendChild(amountInput);

  const previewMain = el('p', '', 'interest-preview');
  const previewMore = el('p', '', 'card__total');

  const dest = destinationField(defaultToIncome);

  const errorBox = el('p', '', 'dialog__error');
  errorBox.setAttribute('role', 'alert');

  const saveButton = el('button', 'Guardar cobro');
  saveButton.type = 'submit';
  const cancelButton = el('button', 'Cancelar', 'btn-secondary');
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', () => dialog.close());

  form.append(choice, amountLabel, previewMain, previewMore, dest.field, errorBox, saveButton, cancelButton);

  const fail = (message) => {
    errorBox.textContent = message;
  };

  /** Mensaje cuando escribes más de lo permitido. */
  const tooMuchMessage = () =>
    mode === 'day'
      ? `Solo puedes cobrar hasta ${formatMoney(maxDay)} (el cobro y ${MAX_AHEAD} por adelantado).`
      : `No puede ser más de lo que debe de atrasado (${formatMoney(info.backlog)}).`;

  /** Qué pasa con lo que te dieron: el nuevo estado, lo que pasa a atrasado y cuántos cobros se adelantan. */
  function outcome(amount) {
    if (mode === 'late') return { r: payLate(state, elapsed, per, amount), short: 0, adv: 0 };
    const s = settle(state, elapsed, per);
    const r = payDay(state, elapsed, per, amount);
    return {
      r,
      short: roundMoney(Math.max(0, r.backlog - s.backlog)), // lo que faltó del cobro del día
      adv: Math.max(0, r.closed - Math.max(elapsed, state.closed)), // periodos que se adelantan
    };
  }

  /** Explica cómo quedaría el préstamo con lo que escribiste. */
  function updatePreview() {
    errorBox.textContent = '';
    previewMore.hidden = false;
    const given = parseAmount(amountInput.value);
    if (given === null) {
      previewMain.textContent = 'Escribe cuánto te dio.';
      previewMore.hidden = true;
      return;
    }
    if (given > maxFor(mode) + EPS) {
      previewMain.textContent = tooMuchMessage();
      previewMore.hidden = true;
      return;
    }

    const { r, short, adv } = outcome(roundMoney(given));
    const after = view({ closed: r.closed, backlog: r.backlog, credit: r.credit }, elapsed, per);
    const lines = [];

    if (mode === 'late') {
      previewMain.textContent =
        after.backlog > 0
          ? `Te seguirá debiendo ${formatMoney(after.backlog)} de atrasado (${after.lateCount} ${plural(after.lateCount, 'cobro', 'cobros')}: ${lateBreakdown(after, per)}).`
          : 'Con esto ya no debe nada atrasado.';
      lines.push(`La fecha del próximo cobro no cambia: ${formatShortDate(addPeriods(loan.firstPaymentDate, loan.frequency, after.nextIndex))}.`);
    } else {
      if (short > 0) previewMain.textContent = `Es menos de lo que toca (${formatMoney(dayDefault)}): ${formatMoney(short)} pasan a interés atrasado.`;
      else if (adv > 0) previewMain.textContent = `Con eso adelantas ${adv} ${plural(adv, 'cobro', 'cobros')}.`;
      else if (r.closed === state.closed && r.credit > 0) previewMain.textContent = 'Queda a tu favor para el siguiente cobro.';
      else previewMain.textContent = info.dayOpen ? 'Cobras el interés del día completo.' : 'Cobras el siguiente interés por adelantado.';

      if (after.credit > 0 && (adv > 0 || r.closed !== state.closed)) {
        lines.push(`Sobran ${formatMoney(after.credit)}: quedan a tu favor para el siguiente cobro.`);
      }
      lines.push(`Próximo cobro: ${formatShortDate(addPeriods(loan.firstPaymentDate, loan.frequency, after.nextIndex))}.`);
      if (after.backlog > 0) {
        lines.push(`Atrasado: ${formatMoney(after.backlog)} (${after.lateCount} ${plural(after.lateCount, 'cobro', 'cobros')}).`);
      }
    }
    previewMore.textContent = lines.join(' ');
  }
  amountInput.addEventListener('input', updatePreview);
  updatePreview();

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const given = parseAmount(amountInput.value);
    if (given === null) return fail('Escribe cuánto te dio (mínimo $0.01).');
    if (given > maxFor(mode) + EPS) return fail(tooMuchMessage());

    const amount = Math.min(roundMoney(given), maxFor(mode));
    const { r, short, adv } = outcome(amount);
    const toIncome = dest.getValue() === 'income';
    const toSavings = dest.getValue() === 'savings';
    const today = activeDate(); // hoy, o el día pasado que elegiste en el calendario

    let detail = loan.person;
    if (mode === 'late') detail = `${loan.person} · interés atrasado`;
    else if (adv > 0) detail = `${loan.person} · adelanto`;

    // 1) Movimiento del cobro en el historial
    const movement = addItem('transactions', {
      type: 'cobro_interes',
      amount,
      note: detail,
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

    // 3) Se anota el cobro en el préstamo con su nuevo estado de atrasos
    const saved = updateItem('loans', loan.id, {
      interestPayments: [...loan.interestPayments, { date: today, amount, kind: 'regular', part: mode }],
      periodsClosed: r.closed,
      interestBacklog: r.backlog,
      interestCredit: r.credit,
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
    let message = mode === 'late' ? `Interés atrasado cobrado: ${formatMoney(amount)}${note}.` : `Interés cobrado: ${formatMoney(amount)}${note}.`;
    if (mode === 'late') message += r.backlog > 0 ? ` Te quedan debiendo ${formatMoney(r.backlog)} de atrasado.` : ' Ya no debe nada atrasado.';
    else if (short > 0) message += ` ${formatMoney(short)} pasan a interés atrasado.`;
    else if (adv > 0) message += ` Adelantaste ${adv} ${plural(adv, 'cobro', 'cobros')}.`;
    showToast(message);
  });

  document.body.appendChild(dialog);
  showDialog(dialog);
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
  amountInput.type = 'text'; // texto (no "número") para poder mostrar comas: 50,000
  amountInput.inputMode = 'decimal';
  amountInput.setAttribute('data-money', '');
  amountInput.autocomplete = 'off';
  amountInput.value = formatAmountText(String(info.outstanding));
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
      if (loan.hasInterest && info.interestOverdue > 0) {
        text += ` Tienes ${formatMoney(info.interestOverdue)} de interés sin cobrar: se descartan al cerrar.`;
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
          ...settledInterest(loan, info),
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
  showDialog(dialog);
}

/* =========================================================
   6. PANTALLA "PRÉSTAMOS" (una tarjeta por préstamo)
   ========================================================= */

/** Etiqueta de estado según cuándo toca cobrar. */
function statusBadges(loan, info, today) {
  if (!loan.hasInterest) return [el('span', 'Sin interés', 'badge')];

  const badges = [];
  if (info.backlog > 0) {
    let text = `Atrasado: ${info.lateCount} ${info.lateCount === 1 ? 'cobro' : 'cobros'} · ${formatMoney(info.backlog)}`;
    if (info.overdueSince) {
      const late = -daysBetween(today, info.overdueSince);
      if (late > 0) text = `Atrasado hace ${late} día${late === 1 ? '' : 's'} · ${info.lateCount} ${info.lateCount === 1 ? 'cobro' : 'cobros'} (${formatMoney(info.backlog)})`;
    }
    badges.push(el('span', text, 'badge badge--late'));
  }

  const days = daysBetween(today, info.nextDue);
  if (info.dayOpen && days < 0) badges.push(el('span', `Cobro del día: hace ${-days} día${days === -1 ? '' : 's'}`, 'badge badge--late'));
  else if (days === 0) badges.push(el('span', 'Toca cobrar hoy', 'badge badge--today'));
  else badges.push(el('span', `Faltan ${days} día${days === 1 ? '' : 's'}`, 'badge'));
  return badges;
}

/** Una tarjeta por préstamo: lo que te deben, avance, datos clave y botones. */
function buildCard(loan, info, today, container) {
  const card = el('article', '', 'item-card');

  const head = el('div', '', 'item-card__head');
  head.append(el('h2', loan.person, 'item-card__name'), ...statusBadges(loan, info, today));
  card.appendChild(head);

  card.append(el('p', 'Falta por cobrar', 'item-card__label'), el('p', formatMoney(info.outstanding), 'item-card__amount'));
  card.appendChild(buildProgress(loan.amount > 0 ? info.recovered / loan.amount : 0, `${formatMoney(info.recovered)} cobrado`));

  const stats = [
    ['Prestado', formatMoney(loan.amount)],
    ['Fecha del préstamo', formatShortDate(loan.date)],
  ];
  if (loan.hasInterest) {
    stats.push(
      ['Interés', `${loan.rate}% ${FREQUENCY_PHRASE[loan.frequency]}`],
      ['Interés por cobro', formatMoney(info.interestNext)],
      ['Próximo cobro', formatShortDate(info.nextDue)],
      ['Intereses cobrados', formatMoney(info.interestCollected)]
    );
    // Lo que ya debió pagarte, separado en atrasado y adelantos
    if (info.interestOverdue > 0) stats.push(['Intereses vencidos', formatMoney(info.interestOverdue)]);
    if (info.backlog > 0) {
      stats.push(['Interés atrasado', formatMoney(info.backlog)]);
      stats.push(['Cobros atrasados', `${info.lateCount} (${lateBreakdown(info, info.interestNext)})`]);
    }
    if (info.ahead > 0) stats.push(['Cobros adelantados', String(info.ahead)]);
    if (info.credit > 0) stats.push(['A su favor', formatMoney(info.credit)]);
  }
  card.appendChild(buildStats(stats));

  const actions = el('div', '', 'item-card__actions');

  if (loan.hasInterest) {
    const interestButton = el('button', 'Cobré el interés', 'btn-small btn-block');
    interestButton.type = 'button';
    interestButton.addEventListener('click', () => openInterestDialog(loan, container, true));
    actions.appendChild(interestButton);
  }

  const principalButton = el(
    'button',
    'Cobré capital',
    loan.hasInterest ? 'btn-small btn-small--outline' : 'btn-small btn-block'
  );
  principalButton.type = 'button';
  principalButton.addEventListener('click', () => openPrincipalDialog(loan, container, true));

  const deleteButton = el('button', 'Eliminar', 'btn-small btn-small--ghost');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteLoan(loan, container));

  actions.append(principalButton, deleteButton);
  card.appendChild(actions);

  return card;
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

  container.appendChild(
    buildViewHeader('Préstamos', 'Dinero que le prestaste a otras personas y que todavía te deben.')
  );

  if (rows.length === 0) {
    container.appendChild(
      buildEmpty(
        'Todavía no has prestado dinero',
        'Aquí verás el dinero que le prestaste a otras personas. Agrégalo desde Inicio, en el botón Préstamo.'
      )
    );
    return;
  }

  const totalOutstanding = roundMoney(rows.reduce((sum, r) => sum + r.info.outstanding, 0));
  // Intereses que ya debieron pagarte y todavía no marcas
  const overdueInterest = roundMoney(rows.reduce((sum, r) => sum + r.info.interestOverdue, 0));
  container.appendChild(
    buildHero('Total por cobrar', formatMoney(totalOutstanding), [
      { label: 'Para gastar', value: formatMoney(getAvailableIncome()) },
      { label: 'Préstamos', value: String(rows.length) },
      { label: 'Intereses vencidos', value: formatMoney(overdueInterest), tone: overdueInterest > 0 ? 'is-out' : '' },
    ])
  );

  // Una tarjeta por préstamo (en pantallas grandes van en dos columnas)
  const list = el('div', '', 'item-list');
  for (const { loan, info } of rows) {
    list.appendChild(buildCard(loan, info, today, container));
  }
  container.appendChild(list);
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