/* =========================================================
   transactions.js
   Maneja los recuadros de Ingresos, Ahorros, Gastos y
   Retiro de ahorros: valida lo escrito, lo guarda con la
   fecha de hoy y mantiene al día los totales de pantalla
   ("Ahorro actual" y "Disponible para gastar").
   ========================================================= */

import { onDayChange } from './calendar.js';
import { addItem, getItems } from './storage.js';
import { showToast } from './ui.js';
import { cleanText, formatMoney, monthKey, parseAmount, roundMoney, todayISO } from './utils.js';

// Una línea por formulario: su id en el HTML, qué tipo de movimiento
// crea y qué mensaje se muestra al guardarse.
const FORMS = [
  { formId: 'form-ingreso', type: 'ingreso', success: 'Ingreso agregado' },
  { formId: 'form-ahorro', type: 'ahorro', success: 'Ahorro agregado', hasIncomeOption: true },
  { formId: 'form-gasto', type: 'gasto', success: 'Gasto agregado', needsNote: true },
  { formId: 'form-retiro', type: 'retiro', success: 'Retiro registrado' },
];

/* =========================================================
   1. TOTALES
   ========================================================= */

/** Ahorro actual = todo lo ahorrado - todo lo retirado (de todos los meses). */
export function getSavingBalance() {
  let balance = 0;
  for (const movement of getItems('transactions')) {
    if (movement.type === 'ahorro') balance += movement.amount;
    else if (movement.type === 'retiro') balance -= movement.amount;
  }
  return roundMoney(balance);
}

/**
 * Cuánto mueve un movimiento tu dinero disponible para gastar:
 *   ingreso, retiro            -> suma
 *   gasto                      -> resta
 *   ahorro, pago de deuda,
 *   préstamo que diste         -> resta, solo si se marcó "Restar de mis ingresos"
 *   cobro de interés o de
 *   capital de un préstamo     -> suma, solo si se marcó "Sumar a mis ingresos"
 */
export function incomeEffect(movement) {
  switch (movement.type) {
    case 'ingreso':
    case 'retiro':
      return movement.amount;
    case 'gasto':
      return -movement.amount;
    case 'ahorro':
    case 'pago_deuda':
    case 'prestamo':
      return movement.fromIncome ? -movement.amount : 0;
    case 'cobro_interes':
    case 'cobro_prestamo':
      return movement.fromIncome ? movement.amount : 0;
    default:
      return 0;
  }
}

/**
 * Lo que traes de los meses anteriores: todo lo que sobró (o faltó)
 * hasta el último día del mes pasado. "month" tiene el formato "AAAA-MM".
 */
export function getCarryOver(month = monthKey(todayISO())) {
  let total = 0;
  for (const movement of getItems('transactions')) {
    if (monthKey(movement.date) < month) total += incomeEffect(movement);
  }
  return roundMoney(total);
}

/**
 * Disponible para gastar en un mes = lo que traes de meses anteriores
 *                                    + lo que se movió en ese mes.
 * Equivale a sumar todos los movimientos hasta el final de ese mes.
 */
export function getAvailableIncome(month = monthKey(todayISO())) {
  let total = 0;
  for (const movement of getItems('transactions')) {
    if (monthKey(movement.date) <= month) total += incomeEffect(movement);
  }
  return roundMoney(total);
}

/**
 * ¿Alcanza tu dinero disponible para restar esta cantidad de tus ingresos?
 * Se usa antes de guardar un gasto, un ahorro, un préstamo o un pago de deuda
 * que se reste de tus ingresos: no se puede sacar más de lo que hay.
 */
export function hasEnoughIncome(amount) {
  return roundMoney(amount) <= getAvailableIncome();
}

/**
 * Mensaje para cuando no alcanza.
 * canUncheck = true agrega la pista de desmarcar "Restar de mis ingresos".
 */
export function notEnoughIncomeMessage(canUncheck = false) {
  let message = `No tienes suficientes ingresos. Disponible: ${formatMoney(getAvailableIncome())}.`;
  if (canUncheck) message += ' Agrega ingresos o desmarca "Restar de mis ingresos".';
  return message;
}

/** Actualiza los totales que se ven en la pantalla de Inicio. */
export function updateDisplays() {
  const saving = document.getElementById('saving-balance');
  if (saving) saving.textContent = formatMoney(getSavingBalance());

  const carry = document.getElementById('income-carry');
  if (carry) carry.textContent = formatMoney(getCarryOver());

  const income = document.getElementById('income-available');
  if (income) income.textContent = formatMoney(getAvailableIncome());
}

/* =========================================================
   2. ENVÍO DE CADA FORMULARIO
   ========================================================= */

function handleSubmit(event, config) {
  event.preventDefault(); // evita que el navegador recargue la página
  const form = event.currentTarget;
  const formData = new FormData(form);

  // Cantidad: segunda capa de validación (la primera son los atributos del HTML)
  const amount = parseAmount(String(formData.get('amount') ?? ''));
  if (amount === null) {
    showToast('Escribe una cantidad válida mayor a 0.', 'error');
    return;
  }

  // Nota ("¿En qué gasté?"), solo en Gastos
  let note = '';
  if (config.needsNote) {
    note = cleanText(String(formData.get('note') ?? ''), 60);
    if (note === '') {
      showToast('Escribe en qué gastaste.', 'error');
      return;
    }
  }

  // Casilla "Restar de mis ingresos" (solo en Ahorros).
  // Una casilla marcada llega como "on"; si no está marcada, no llega.
  const fromIncome = config.hasIncomeOption && formData.get('fromIncome') === 'on';

  // No se puede gastar (ni restar de tus ingresos) más de lo que tienes disponible
  if ((config.type === 'gasto' || fromIncome) && !hasEnoughIncome(amount)) {
    showToast(notEnoughIncomeMessage(fromIncome), 'error');
    return;
  }

  // No se puede sacar más de lo que hay ahorrado
  if (config.type === 'retiro') {
    const balance = getSavingBalance();
    if (amount > balance) {
      showToast(`No tienes tanto ahorrado. Disponible: ${formatMoney(balance)}`, 'error');
      return;
    }
  }

  const saved = addItem('transactions', {
    type: config.type,
    amount,
    note,
    date: todayISO(),
    fromIncome,
  });
  if (!saved) {
    showToast('No se pudo guardar. Revisa el espacio de tu teléfono.', 'error');
    return;
  }

  form.reset(); // deja los cuadros vacíos (y la casilla en su valor inicial)
  updateDisplays();

  let extra = '';
  if (fromIncome || config.type === 'gasto') extra = ' (restado de tus ingresos)';
  else if (config.type === 'retiro') extra = ' (sumado a tus ingresos)';
  showToast(`${config.success}: ${formatMoney(amount)}${extra}`);
}

/* =========================================================
   3. ARRANQUE
   ========================================================= */

export function initTransactions() {
  for (const config of FORMS) {
    const form = document.getElementById(config.formId);
    if (form) form.addEventListener('submit', (event) => handleSubmit(event, config));
  }
  updateDisplays();

  // Si cambia el día (y con él, quizá el mes), se recalculan los totales
  onDayChange(updateDisplays);
}