/* =========================================================
   debts.js
   Todo lo de Deudas:
     1. El recuadro de Inicio (registrar una deuda).
     2. La pantalla "Deudas": ingresos disponibles, una tarjeta
        por deuda, marcar pagos, abonos a capital, liquidar y
        eliminación automática al terminar.

   CÓMO SE CALCULAN LOS INTERESES (igual que un crédito real):
     - Cada pago cubre primero el interés del periodo
       (capital pendiente x tasa) y el resto baja el capital.
     - Un abono a capital baja el capital de golpe, así que los
       intereses de los siguientes periodos son menores.
     - La tasa se calcula sola al registrar la deuda, con el
       precio de contado, el total y el pago de cada periodo.
   ========================================================= */

import { addItem, getItems, removeItem, updateItem } from './storage.js';
import { getAvailableIncome, updateDisplays } from './transactions.js';
import { showToast } from './ui.js';
import {
  FREQUENCIES,
  FREQUENCY_LABELS,
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
  roundMoney,
  todayISO,
} from './utils.js';



// Por debajo de 1 centavo consideramos que ya no se debe nada
const EPS = 0.01;

// Para mostrar la tasa también como porcentaje anual aproximado
const PERIODS_PER_YEAR = { semanal: 52, quincenal: 24, mensual: 12 };
const PERIOD_ADJECTIVE = { semanal: 'semanal', quincenal: 'quincenal', mensual: 'mensual' };

/* =========================================================
   1. CÁLCULOS
   ========================================================= */

/** Cuántos pagos hacen falta para terminar (se calcula en centavos para evitar errores decimales). */
export function countPaymentsNeeded(total, payment) {
  return Math.ceil(Math.round(total * 100) / Math.round(payment * 100));
}

/** Valor presente de un plan de pagos (pagos completos + uno final menor) con una tasa por periodo. */
function presentValue(rate, total, payment) {
  const full = Math.floor(Math.round(total * 100) / Math.round(payment * 100));
  const last = roundMoney(total - full * payment);
  let pv = 0;
  for (let i = 1; i <= full; i++) pv += payment / Math.pow(1 + rate, i);
  if (last > 0.004) pv += last / Math.pow(1 + rate, full + 1);
  return pv;
}

/**
 * Calcula la tasa de interés por periodo (semana, quincena o mes) de una
 * compra a crédito: la tasa con la que los pagos "valen" el precio de contado.
 * Devuelve 0 si no hay interés o no se puede calcular.
 */
export function solvePeriodRate(cashPrice, total, payment) {
  if (!(cashPrice > 0) || !(total > cashPrice) || !(payment > 0)) return 0;
  if (total / payment > 5000) return 0; // plan absurdamente largo: no calculamos
  let low = 0;
  let high = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (presentValue(mid, total, payment) > cashPrice) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Simula los pagos que faltan: cuántos son y cuánto sumarán.
 * ok = false si el pago no alcanza ni para cubrir el interés (la deuda nunca acabaría).
 */
function project(balance, payment, rate) {
  let left = balance;
  let count = 0;
  let total = 0;
  while (left > EPS && count < 5000) {
    const due = left * (1 + rate);
    count++;
    if (due <= payment + EPS) {
      total += due; // último pago, puede ser menor al normal
      return { ok: true, count, total: roundMoney(total) };
    }
    if (payment <= left * rate + EPS) {
      return { ok: false, count: 0, total: roundMoney(balance) };
    }
    total += payment;
    left = due - payment;
  }
  return { ok: count < 5000, count, total: roundMoney(total) };
}

/** Tasa por periodo de una deuda (las deudas viejas la calculan al vuelo). */
function debtRate(debt) {
  if (debt.periodRate > 0) return debt.periodRate;
  return solvePeriodRate(debt.cashPrice, debt.total, debt.payment);
}

/** Datos calculados de una deuda: capital pendiente, intereses, pagos que faltan y cuándo toca pagar. */
export function describeDebt(debt, today = todayISO()) {
  const rate = debtRate(debt);

  // Se vuelven a "tocar" todos los pagos en orden para saber cuánto capital queda:
  //  - pago normal: primero se cubre el interés del periodo, el resto baja el capital
  //  - abono a capital: baja el capital directo
  let balance = rate > 0 ? debt.cashPrice : debt.total;
  for (const p of debt.payments) {
    balance = p.kind === 'capital' ? balance - p.amount : balance * (1 + rate) - p.amount;
    if (balance < EPS) balance = 0;
  }
  balance = roundMoney(balance);

  const paid = roundMoney(debt.payments.reduce((sum, p) => sum + p.amount, 0));

  // Lo que pagarías si sigues con el pago actual hasta terminar
  const plan = project(balance, debt.payment, rate);
  const remaining = plan.ok ? plan.total : balance;
  const interestLeft = roundMoney(Math.max(0, remaining - balance));

  // Solo los pagos normales avanzan el calendario; un abono a capital no
  const scheduled = debt.payments.filter((p) => p.kind !== 'capital').length;
  const nextDue = addPeriods(debt.firstPaymentDate, debt.frequency, scheduled);
  const pending = Math.max(0, countDue(debt.firstPaymentDate, debt.frequency, today) - scheduled);

  // El último pago puede ser menor al normal
  const nextAmount = roundMoney(Math.min(debt.payment, balance * (1 + rate)));

  return {
    paid,
    rate,
    balance, // capital que todavía debes
    remaining, // lo que pagarías en total si sigues pagando
    interestLeft, // intereses que faltan por pagar
    paymentsLeft: plan.count,
    nextDue,
    pending,
    nextAmount,
  };
}

/** Lee una cantidad opcional de un formulario: '' = no se escribió, null = escribió algo inválido. */
function readOptionalAmount(formData, name) {
  const text = String(formData.get(name) ?? '').trim();
  if (text === '') return 0;
  return parseAmount(text);
}

/** "1.28% semanal (≈ 66% anual)" */
function describeRate(rate, frequency) {
  const perYear = rate * PERIODS_PER_YEAR[frequency];
  return `${(rate * 100).toFixed(2)}% ${PERIOD_ADJECTIVE[frequency]} (≈ ${Math.round(perYear * 100)}% anual)`;
}

/* =========================================================
   2. REGISTRAR UNA DEUDA (recuadro de Inicio)
   ========================================================= */

function handleSubmit(event) {
  event.preventDefault(); // evita que el navegador recargue la página
  const form = event.currentTarget;
  const formData = new FormData(form);

  const concept = cleanText(String(formData.get('concept') ?? ''), 60);
  if (concept === '') {
    showToast('Escribe qué debes.', 'error');
    return;
  }

  const total = parseAmount(String(formData.get('total') ?? ''));
  if (total === null) {
    showToast('Escribe el total a pagar con intereses (mayor a 0).', 'error');
    return;
  }

  const payment = parseAmount(String(formData.get('payment') ?? ''));
  if (payment === null) {
    showToast('Escribe cuánto pagas cada vez (mayor a 0).', 'error');
    return;
  }
  if (payment > total) {
    showToast('El pago no puede ser mayor que la deuda total.', 'error');
    return;
  }

  const frequency = String(formData.get('frequency') ?? '');
  if (!FREQUENCIES.includes(frequency)) {
    showToast('Elige cada cuánto pagas.', 'error');
    return;
  }

  const firstPaymentDate = String(formData.get('firstPayment') ?? '');
  if (!isValidISODate(firstPaymentDate)) {
    showToast('Elige la fecha del primer pago.', 'error');
    return;
  }

  // Opcionales (compras a crédito)
  const cashPrice = readOptionalAmount(formData, 'cashPrice');
  if (cashPrice === null) {
    showToast('El precio de contado no es válido.', 'error');
    return;
  }
  if (cashPrice > total) {
    showToast('El precio de contado no puede ser mayor al total con intereses.', 'error');
    return;
  }

  const settleAmount = readOptionalAmount(formData, 'settleAmount');
  if (settleAmount === null) {
    showToast('El monto de "liquidar hoy" no es válido.', 'error');
    return;
  }
  if (settleAmount > total) {
    showToast('"Liquidar hoy" no puede ser mayor al total a pagar.', 'error');
    return;
  }

  // La tasa se calcula sola con el precio de contado (0 si no hay interés)
  const periodRate = solvePeriodRate(cashPrice, total, payment);

  const saved = addItem('debts', {
    concept,
    total,
    payment,
    frequency,
    date: todayISO(),
    firstPaymentDate,
    cashPrice,
    periodRate,
    settleAmount,
    settleDate: settleAmount > 0 ? todayISO() : '',
  });
  if (!saved) {
    showToast('No se pudo guardar. Revisa el espacio de tu teléfono.', 'error');
    return;
  }

  form.reset(); // limpia todos los campos

  // Mensaje: cuántos pagos son y de cuánto es el último
  const count = countPaymentsNeeded(total, payment);
  const last = roundMoney(total - payment * (count - 1));
  let plan;
  if (count === 1) {
    plan = `1 pago de ${formatMoney(total)}`;
  } else if (last < payment) {
    plan = `${count - 1} pagos de ${formatMoney(payment)} y uno final de ${formatMoney(last)}`;
  } else {
    plan = `${count} pagos de ${formatMoney(payment)}`;
  }
  let message = `Deuda agregada: ${concept}, ${formatMoney(total)}. ${plan}.`;
  if (periodRate > 0) message += ` Tasa estimada: ${describeRate(periodRate, frequency)}.`;
  showToast(message);
}

/* =========================================================
   3. MARCAR UN PAGO / ELIMINAR
   ========================================================= */

function openPaymentDialog(debt, container, defaultFromIncome) {
  const info = describeDebt(debt);
  if (info.balance <= 0) return;

  const { dialog, form } = createDialog();

  form.appendChild(el('h2', `Marcar pago: ${debt.concept}`));

  // ¿Este es el último pago?
  const isLast = info.balance * (1 + info.rate) - info.nextAmount < EPS;
  let text = `Vas a marcar un pago de ${formatMoney(info.nextAmount)}.`;
  if (isLast) {
    text += ' Es el último: la deuda se liquida y se elimina de la lista.';
  } else {
    text += ` Después te faltarán ${formatMoney(roundMoney(Math.max(0, info.remaining - info.nextAmount)))}.`;
  }
  form.appendChild(el('p', text, 'interest-preview'));

  const income = incomeCheckbox(defaultFromIncome);

  const errorBox = el('p', '', 'dialog__error');
  errorBox.setAttribute('role', 'alert');

  const saveButton = el('button', 'Marcar pago');
  saveButton.type = 'submit';
  const cancelButton = el('button', 'Cancelar', 'btn-secondary');
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', () => dialog.close());

  form.append(income.label, errorBox, saveButton, cancelButton);

  const fail = (message) => {
    errorBox.textContent = message;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const fromIncome = income.box.checked;
    const today = todayISO();

    // 1) Se registra como movimiento (así el historial sobrevive aunque la deuda se elimine)
    const movement = addItem('transactions', {
      type: 'pago_deuda',
      amount: info.nextAmount,
      note: debt.concept,
      date: today,
      fromIncome,
    });
    if (!movement) return fail('No se pudo guardar el pago. Revisa el espacio de tu teléfono.');

    // 2) Se anota el pago en la deuda, o se elimina si ya quedó pagada
    const saved = isLast
      ? removeItem('debts', debt.id)
      : updateItem('debts', debt.id, {
          payments: [...debt.payments, { date: today, amount: info.nextAmount, kind: 'regular' }],
        }) !== null;

    if (!saved) {
      removeItem('transactions', movement.id); // deshacer el paso 1
      return fail('No se pudo guardar el pago. Intenta de nuevo.');
    }

    dialog.close();
    updateDisplays(); // actualiza "Disponible para gastar" en Inicio
    renderDebts(container);

    const extra = fromIncome ? ' (restado de tus ingresos)' : '';
    if (isLast) {
      showToast(`¡Deuda liquidada: ${debt.concept}! Último pago: ${formatMoney(info.nextAmount)}${extra}.`);
    } else {
      const left = roundMoney(Math.max(0, info.remaining - info.nextAmount));
      showToast(`Pago registrado: ${formatMoney(info.nextAmount)}${extra}. Faltan ${formatMoney(left)}.`);
    }
  });

  document.body.appendChild(dialog);
  dialog.showModal();
}

function deleteDebt(debt, container) {
  const ok = window.confirm(
    `¿Eliminar la deuda "${debt.concept}"? Los pagos que ya marcaste se conservan en tu historial.`
  );
  if (!ok) return;

  if (!removeItem('debts', debt.id)) {
    showToast('No se pudo eliminar. Intenta de nuevo.', 'error');
    return;
  }
  renderDebts(container);
  showToast('Deuda eliminada.');
}

/* =========================================================
   4. VENTANITAS (abonar a capital y liquidar)
   ========================================================= */

/** Crea una etiqueta con un cuadro numérico. */
function numberField(labelText, name, value = '') {
  const label = document.createElement('label');
  label.appendChild(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.name = name;
  input.type = 'number';
  input.inputMode = 'decimal';
  input.min = '0.01';
  input.step = '0.01';
  input.value = value;
  label.appendChild(input);
  return { label, input };
}

/** Casilla "Restar de mis ingresos" para las ventanitas. */
function incomeCheckbox(checked) {
  const label = el('label', '', 'check');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  label.append(box, el('span', 'Restar de mis ingresos'));
  return { label, box };
}

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

function pluralPayments(n) {
  return `${n} pago${n === 1 ? '' : 's'}`;
}

function openCapitalDialog(debt, container, defaultFromIncome) {
  const info = describeDebt(debt);
  if (info.balance <= 0) return;

  const { dialog, form } = createDialog();

  form.appendChild(el('h2', `Abonar a capital: ${debt.concept}`));
  const intro =
    info.rate > 0
      ? `Capital que debes: ${formatMoney(info.balance)}. Pagas ${formatMoney(debt.payment)} ${FREQUENCY_LABELS[debt.frequency].toLowerCase()}. Al bajar el capital, también bajan los intereses.`
      : `Te faltan ${formatMoney(info.balance)}. Pagas ${formatMoney(debt.payment)} ${FREQUENCY_LABELS[debt.frequency].toLowerCase()}.`;
  form.appendChild(el('p', intro, 'card__total'));

  const extraField = numberField('¿Cuánto abonas a capital?', 'extra');
  const payField = numberField('Pago por periodo después del abono', 'newPayment', String(debt.payment));
  const tip = el(
    'p',
    'Si dejas el mismo pago, terminas antes y ahorras más intereses. Si lo bajas, pagas menos cada vez pero tardas más.',
    'card__total'
  );
  const preview = el('p', '', 'interest-preview');
  const income = incomeCheckbox(defaultFromIncome);

  const errorBox = el('p', '', 'dialog__error');
  errorBox.setAttribute('role', 'alert');

  const saveButton = el('button', 'Guardar abono');
  saveButton.type = 'submit';
  const cancelButton = el('button', 'Cancelar', 'btn-secondary');
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', () => dialog.close());

  form.append(extraField.label, payField.label, tip, preview, income.label, errorBox, saveButton, cancelButton);

  // Vista previa: cuánto quedaría, cuántos pagos y cuánto se ahorra
  function updatePreview() {
    errorBox.textContent = '';
    const extra = parseAmount(extraField.input.value);
    if (extra === null) {
      preview.textContent = 'Escribe cuánto abonas para ver cuánto te ahorras.';
      payField.label.hidden = false;
      tip.hidden = false;
      return;
    }
    if (extra > info.balance + EPS) {
      preview.textContent = `No puedes abonar más del capital que debes (${formatMoney(info.balance)}).`;
      payField.label.hidden = false;
      tip.hidden = false;
      return;
    }
    const newBalance = roundMoney(info.balance - extra);
    if (newBalance < EPS) {
      preview.textContent = 'Con este abono liquidas la deuda.';
      payField.label.hidden = true; // ya no hay pagos futuros
      tip.hidden = true;
      return;
    }
    payField.label.hidden = false;
    tip.hidden = false;

    const newPay = parseAmount(payField.input.value);
    if (newPay === null) {
      preview.textContent = 'Escribe cuánto pagarás por periodo.';
      return;
    }
    const plan = project(newBalance, newPay, info.rate);
    if (!plan.ok) {
      preview.textContent = `Ese pago no alcanza ni para cubrir los intereses de cada periodo (≈ ${formatMoney(roundMoney(newBalance * info.rate))}).`;
      return;
    }
    const saving = roundMoney(info.remaining - (extra + plan.total));
    let text = `Te quedarían ${formatMoney(newBalance)} de capital: ${pluralPayments(plan.count)} más (${formatMoney(plan.total)} en total).`;
    if (saving > 0.005) text += ` Ahorras ${formatMoney(saving)} en intereses.`;
    preview.textContent = text;
  }
  extraField.input.addEventListener('input', updatePreview);
  payField.input.addEventListener('input', updatePreview);
  updatePreview();

  const fail = (message) => {
    errorBox.textContent = message;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const extra = parseAmount(extraField.input.value);
    if (extra === null) return fail('Escribe cuánto abonas a capital (mayor a 0).');
    if (extra > info.balance + EPS) {
      return fail(`No puedes abonar más del capital que debes (${formatMoney(info.balance)}).`);
    }

    const newBalance = roundMoney(info.balance - extra);
    const isFinished = newBalance < EPS;

    let newPayment = debt.payment;
    if (!isFinished) {
      newPayment = parseAmount(payField.input.value);
      if (newPayment === null) return fail('Escribe el nuevo pago (mayor a 0).');
      const maxPayment = roundMoney(newBalance * (1 + info.rate));
      if (newPayment > maxPayment + EPS) {
        return fail(`El pago no puede ser mayor a lo que queda (${formatMoney(maxPayment)}).`);
      }
      if (!project(newBalance, newPayment, info.rate).ok) {
        return fail('Ese pago no alcanza ni para cubrir los intereses. Escribe uno más grande.');
      }
    }

    const fromIncome = income.box.checked;
    const today = todayISO();

    // 1) Movimiento en el historial
    const movement = addItem('transactions', {
      type: 'pago_deuda',
      amount: extra,
      note: `Abono a capital: ${debt.concept}`,
      date: today,
      fromIncome,
    });
    if (!movement) return fail('No se pudo guardar. Revisa el espacio de tu teléfono.');

    // 2) Se anota en la deuda (y cambia el pago por periodo), o se elimina si quedó pagada
    const saved = isFinished
      ? removeItem('debts', debt.id)
      : updateItem('debts', debt.id, {
          payment: newPayment,
          payments: [...debt.payments, { date: today, amount: extra, kind: 'capital' }],
        }) !== null;

    if (!saved) {
      removeItem('transactions', movement.id); // deshacer el paso 1
      return fail('No se pudo guardar el abono. Intenta de nuevo.');
    }

    dialog.close();
    updateDisplays();
    renderDebts(container);

    const note = fromIncome ? ' (restado de tus ingresos)' : '';
    if (isFinished) {
      showToast(`¡Deuda liquidada: ${debt.concept}! Abono: ${formatMoney(extra)}${note}.`);
    } else {
      const plan = project(newBalance, newPayment, info.rate);
      const saving = roundMoney(info.remaining - (extra + plan.total));
      let message = `Abono a capital: ${formatMoney(extra)}${note}. Capital pendiente: ${formatMoney(newBalance)}. Faltan ${pluralPayments(plan.count)} de ${formatMoney(newPayment)}.`;
      if (saving > 0.005) message += ` Ahorras ${formatMoney(saving)} en intereses.`;
      showToast(message);
    }
  });

  document.body.appendChild(dialog);
  dialog.showModal();
  extraField.input.focus();
}

/**
 * Liquidar: pagas de una vez el monto que te da la tienda
 * ("liquidar hoy") y la deuda se elimina. Ese monto cambia con el
 * tiempo, así que también puedes solo guardar el dato nuevo.
 */
function openSettleDialog(debt, container, defaultFromIncome) {
  const info = describeDebt(debt);
  if (info.balance <= 0) return;

  const { dialog, form } = createDialog();

  form.appendChild(el('h2', `Liquidar: ${debt.concept}`));

  let hint;
  if (info.rate > 0) {
    hint = `Según tus pagos, el capital que falta es ${formatMoney(info.balance)}. La tienda suele cobrar ese monto más los intereses de los días desde tu último pago. Confirma la cantidad exacta con ella.`;
  } else {
    hint = 'Escribe el monto con el que vas a liquidar la deuda.';
  }
  if (debt.settleAmount > 0) {
    hint += ` Último dato guardado: ${formatMoney(debt.settleAmount)} (${formatShortDate(debt.settleDate)}).`;
  }
  form.appendChild(el('p', hint, 'card__total'));

  const settleField = numberField(
    '¿Con cuánto liquidas hoy?',
    'settle',
    debt.settleAmount > 0 ? String(debt.settleAmount) : ''
  );
  const preview = el('p', '', 'interest-preview');
  const income = incomeCheckbox(defaultFromIncome);

  const errorBox = el('p', '', 'dialog__error');
  errorBox.setAttribute('role', 'alert');

  const settleButton = el('button', 'Liquidar y cerrar la deuda');
  settleButton.type = 'submit';
  const saveOnlyButton = el('button', 'Solo guardar este monto', 'btn-secondary');
  saveOnlyButton.type = 'button';
  const cancelButton = el('button', 'Cancelar', 'btn-secondary');
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', () => dialog.close());

  form.append(settleField.label, preview, income.label, errorBox, settleButton, saveOnlyButton, cancelButton);

  function updatePreview() {
    errorBox.textContent = '';
    const amount = parseAmount(settleField.input.value);
    if (amount === null) {
      preview.textContent = `Si sigues pagando, todavía pagarías ${formatMoney(info.remaining)}.`;
    } else if (amount > info.remaining + EPS) {
      preview.textContent = `Eso es más de lo que te falta pagar (${formatMoney(info.remaining)}).`;
    } else {
      const saving = roundMoney(info.remaining - amount);
      preview.textContent = `Si sigues pagando, pagarías ${formatMoney(info.remaining)}. Liquidando hoy te ahorras ${formatMoney(saving)}.`;
    }
  }
  settleField.input.addEventListener('input', updatePreview);
  updatePreview();

  const fail = (message) => {
    errorBox.textContent = message;
  };

  // Solo guardar el dato nuevo, sin pagar nada
  saveOnlyButton.addEventListener('click', () => {
    const amount = parseAmount(settleField.input.value);
    if (amount === null) return fail('Escribe el monto de "liquidar hoy" (mayor a 0).');
    if (amount > info.remaining + EPS) {
      return fail(`No puede ser mayor a lo que te falta (${formatMoney(info.remaining)}).`);
    }
    const saved = updateItem('debts', debt.id, { settleAmount: amount, settleDate: todayISO() });
    if (saved === null) return fail('No se pudo guardar. Intenta de nuevo.');
    dialog.close();
    renderDebts(container);
    showToast(`Guardado: liquidar hoy ${formatMoney(amount)}.`);
  });

  // Liquidar de verdad
  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const amount = parseAmount(settleField.input.value);
    if (amount === null) return fail('Escribe con cuánto liquidas (mayor a 0).');
    if (amount > info.remaining + EPS) {
      return fail(`No puedes pagar más de lo que te falta (${formatMoney(info.remaining)}).`);
    }

    const fromIncome = income.box.checked;
    const ok = window.confirm(
      `¿Liquidar "${debt.concept}" con ${formatMoney(amount)}?\n` +
        `${fromIncome ? 'Se restará de tus ingresos.' : 'No se restará de tus ingresos.'}\n` +
        'La deuda se eliminará de la lista.'
    );
    if (!ok) return;

    // 1) Movimiento en el historial
    const movement = addItem('transactions', {
      type: 'pago_deuda',
      amount,
      note: `Liquidación: ${debt.concept}`,
      date: todayISO(),
      fromIncome,
    });
    if (!movement) return fail('No se pudo guardar. Revisa el espacio de tu teléfono.');

    // 2) La deuda se elimina (quedó liquidada)
    if (!removeItem('debts', debt.id)) {
      removeItem('transactions', movement.id); // deshacer el paso 1
      return fail('No se pudo cerrar la deuda. Intenta de nuevo.');
    }

    dialog.close();
    updateDisplays();
    renderDebts(container);

    const saving = roundMoney(Math.max(0, info.remaining - amount));
    const note = fromIncome ? ' (restado de tus ingresos)' : '';
    showToast(`¡Deuda liquidada: ${debt.concept}! Pagaste ${formatMoney(amount)}${note} y te ahorraste ${formatMoney(saving)}.`);
  });

  document.body.appendChild(dialog);
  dialog.showModal();
  settleField.input.focus();
}

/* =========================================================
   5. PANTALLA "DEUDAS" (una tarjeta por deuda)
   ========================================================= */

/** Etiqueta de estado según cuándo toca pagar. */
function statusBadge(info, today) {
  const days = daysBetween(today, info.nextDue);
  if (days < 0) {
    const late = -days;
    let text = `Vencido hace ${late} día${late === 1 ? '' : 's'}`;
    if (info.pending > 1) text += ` · ${info.pending} pagos pendientes`;
    return el('span', text, 'badge badge--late');
  }
  if (days === 0) return el('span', 'Toca pagar hoy', 'badge badge--today');
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

/** Parte de arriba de la tarjeta: el nombre de la deuda y su estado. */
function titleCell(debt, info, today) {
  const td = el('td', '', 'cell-title');
  td.appendChild(el('span', debt.concept, 'cell-title__name'));
  td.appendChild(statusBadge(info, today));
  return td;
}

function buildRow(debt, info, today, container) {
  const row = document.createElement('tr');

  row.appendChild(titleCell(debt, info, today));
  row.appendChild(cell('Pago', formatMoney(debt.payment), 'num'));
  row.appendChild(cell('Cada cuánto', FREQUENCY_LABELS[debt.frequency]));
  row.appendChild(cell('Próximo pago', formatShortDate(info.nextDue)));
  row.appendChild(cell('Pagos que faltan', String(info.paymentsLeft), 'num'));
  row.appendChild(cell('Pagado', formatMoney(info.paid), 'num'));
  row.appendChild(cell('Falta pagar', formatMoney(info.remaining), 'num'));

  // Solo en compras a crédito con interés: capital, intereses y tasa
  if (info.rate > 0) {
    row.appendChild(cell('Capital que falta', formatMoney(info.balance), 'num cell-credit'));
    row.appendChild(cell('Intereses que faltan', formatMoney(info.interestLeft), 'num cell-credit'));
    row.appendChild(cell('Tasa estimada', describeRate(info.rate, debt.frequency), 'cell-credit'));
  }

  const actions = el('td', '', 'actions');

  const payButton = el('button', 'Marcar pago', 'btn-small');
  payButton.type = 'button';
  payButton.addEventListener('click', () => openPaymentDialog(debt, container, true));

  const capitalButton = el('button', 'Abonar a capital', 'btn-small btn-small--outline');
  capitalButton.type = 'button';
  capitalButton.addEventListener('click', () => openCapitalDialog(debt, container, true));

  const settleButton = el('button', 'Liquidar', 'btn-small btn-small--outline');
  settleButton.type = 'button';
  settleButton.addEventListener('click', () => openSettleDialog(debt, container, true));

  const deleteButton = el('button', 'Eliminar', 'btn-small btn-small--ghost');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteDebt(debt, container));

  actions.append(payButton, capitalButton, settleButton, deleteButton);
  row.appendChild(actions);

  return row;
}

/** Dibuja la pantalla de Deudas dentro de su contenedor. */
/** Dibuja la pantalla de Deudas dentro de su contenedor. */
export function renderDebts(container) {
  clear(container);
  const today = todayISO();

  // Las deudas más urgentes (próximo pago más cercano) van primero
  const rows = getItems('debts')
    .map((debt) => ({ debt, info: describeDebt(debt, today) }))
    .sort((a, b) => (a.info.nextDue < b.info.nextDue ? -1 : a.info.nextDue > b.info.nextDue ? 1 : 0));

  // Tarjeta de arriba: deudas a la izquierda, ingresos a la derecha
  const summary = el('section', '', 'card');

  if (rows.length === 0) {
    summary.appendChild(el('h2', 'Mis deudas'));
    summary.appendChild(el('p', 'No tienes deudas registradas.', 'card__total'));
    container.appendChild(summary);
    return;
  }

  const top = el('div', '', 'debts-top');

  // Lado izquierdo: Mis deudas
  const debtsSide = el('div', '', 'debts-top__side');
  debtsSide.appendChild(el('h2', 'Mis deudas'));
  const totalRemaining = roundMoney(rows.reduce((sum, r) => sum + r.info.remaining, 0));
  const totalLine = el('p', 'Debo en total: ', 'card__total');
  totalLine.appendChild(el('strong', formatMoney(totalRemaining)));
  debtsSide.appendChild(totalLine);

  // Lado derecho: Mis ingresos
  const incomeSide = el('div', '', 'debts-top__side');
  incomeSide.appendChild(el('h2', 'Mis ingresos'));
  const incomeLine = el('p', 'Disponible: ', 'card__total');
  incomeLine.appendChild(el('strong', formatMoney(getAvailableIncome())));
  incomeSide.appendChild(incomeLine);

  top.append(debtsSide, incomeSide);
  summary.appendChild(top);
  container.appendChild(summary);

  // Una tarjeta por deuda (el CSS las acomoda según el ancho de la pantalla)
  const card = el('section', '', 'card');
  const wrap = el('div', '', 'table-wrap');
  const table = el('table', '', 'table');

  const tbody = document.createElement('tbody');
  for (const { debt, info } of rows) {
    tbody.appendChild(buildRow(debt, info, today, container));
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  container.appendChild(card);
}

/* =========================================================
   6. ARRANQUE
   ========================================================= */

export function initDebts() {
  const form = document.getElementById('form-deuda');
  if (form) form.addEventListener('submit', handleSubmit);
}