/* =========================================================
   summary.js
   Pantalla "Resumen": todo tu dinero de un vistazo.
     1. Selector de mes (‹ ›).
     2. Ingresos y gastos del mes y lo disponible al cierre.
     3. Ahorros.
     4. Deudas y préstamos (situación de hoy).
     5. Lo que viene (próximos pagos y cobros).
     6. Movimientos del mes.
   Solo lee los datos: no guarda ni cambia nada.
   ========================================================= */

import { describeDebt } from './debts.js';
import { describeLoan } from './loans.js';
import { getItems } from './storage.js';
import { getAvailableIncome, getCarryOver, incomeEffect } from './transactions.js';
import {
  clear,
  daysBetween,
  el,
  formatMoney,
  formatShortDate,
  monthKey,
  roundMoney,
  todayISO,
} from './utils.js';

// Máximo de movimientos que se dibujan en la lista del mes
const MAX_MOVEMENTS = 100;
// Máximo de renglones en "Lo que viene"
const MAX_UPCOMING = 6;

const monthFormatter = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' });

const TYPE_LABELS = {
  ingreso: 'Ingreso',
  ahorro: 'Ahorro',
  gasto: 'Gasto',
  retiro: 'Retiro de ahorros',
  pago_deuda: 'Pago de deuda',
  prestamo: 'Préstamo dado',
  cobro_interes: 'Cobro de interés',
  cobro_prestamo: 'Cobro de capital',
};

// El mes que se está viendo, con formato "AAAA-MM"
let shownMonth = '';

/* =========================================================
   1. AYUDAS DE FECHAS Y TEXTO
   ========================================================= */

/** "2026-11" -> "Noviembre de 2026" */
function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  const text = monthFormatter.format(new Date(year, month - 1, 1));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Mueve un mes hacia adelante (+1) o hacia atrás (-1). */
function shiftMonth(key, delta) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Un renglón "texto ....... cantidad". kind: 'in' (verde), 'out' (rojo), 'total' (grande). */
function sumRow(label, value, kind = '') {
  const row = el('div', '', `sum-row${kind ? ` sum-row--${kind}` : ''}`);
  row.append(el('span', label), el('strong', value));
  return row;
}

function plural(n, singular, pluralText) {
  return n === 1 ? singular : pluralText;
}

/* =========================================================
   2. CÁLCULOS
   ========================================================= */

/** Suma los movimientos de un mes por categoría. */
function summarizeMonth(month, movements) {
  const t = {
    ingresos: 0, // ingresos que escribiste
    retiros: 0, // dinero que sacaste de ahorros
    cobros: 0, // cobros de préstamos que sumaste a ingresos
    gastos: 0,
    ahorros: 0, // ahorros que restaste de ingresos
    pagosDeuda: 0, // pagos de deuda que restaste de ingresos
    prestamos: 0, // préstamos que diste y restaste de ingresos
    savedTotal: 0, // todo lo ahorrado en el mes (venga de donde venga)
    debtPaidTotal: 0, // todo lo pagado a deudas en el mes
    loanedTotal: 0, // todo lo prestado en el mes
    collectedTotal: 0, // todo lo cobrado de préstamos en el mes
    principalCollected: 0, // de lo cobrado, lo que fue capital
    interestCollected: 0, // de lo cobrado, lo que fue interés
  };

  for (const m of movements) {
    if (monthKey(m.date) !== month) continue;
    switch (m.type) {
      case 'ingreso':
        t.ingresos += m.amount;
        break;
      case 'retiro':
        t.retiros += m.amount;
        break;
      case 'gasto':
        t.gastos += m.amount;
        break;
      case 'ahorro':
        t.savedTotal += m.amount;
        if (m.fromIncome) t.ahorros += m.amount;
        break;
      case 'pago_deuda':
        t.debtPaidTotal += m.amount;
        if (m.fromIncome) t.pagosDeuda += m.amount;
        break;
      case 'prestamo':
        t.loanedTotal += m.amount;
        if (m.fromIncome) t.prestamos += m.amount;
        break;
      case 'cobro_interes':
      case 'cobro_prestamo':
        t.collectedTotal += m.amount;
        if (m.type === 'cobro_interes') t.interestCollected += m.amount;
        else t.principalCollected += m.amount;
        if (m.fromIncome) t.cobros += m.amount;
        break;
      default:
        break;
    }
  }

  for (const key of Object.keys(t)) t[key] = roundMoney(t[key]);
  return t;
}

/** Ahorro acumulado hasta el final de un mes (ahorrado - retirado). */
function savingsUntil(month, movements) {
  let balance = 0;
  for (const m of movements) {
    if (monthKey(m.date) > month) continue;
    if (m.type === 'ahorro') balance += m.amount;
    else if (m.type === 'retiro') balance -= m.amount;
  }
  return roundMoney(balance);
}

/** Explica un movimiento: título, detalle, cantidad con signo y color. */
function describeMovement(m) {
  const effect = incomeEffect(m);

  let detail;
  switch (m.type) {
    case 'ingreso':
      detail = 'Suma a tus ingresos';
      break;
    case 'gasto':
      detail = 'Resta de tus ingresos';
      break;
    case 'retiro':
      detail = 'Sale de ahorros y suma a tus ingresos';
      break;
    case 'ahorro':
      detail = m.fromIncome ? 'Resta de tus ingresos y va a ahorros' : 'Va directo a ahorros';
      break;
    case 'cobro_interes':
    case 'cobro_prestamo':
      detail = m.fromIncome ? 'Sumado a tus ingresos' : 'No sumado a tus ingresos';
      break;
    default: // pago_deuda y prestamo
      detail = m.fromIncome ? 'Restado de tus ingresos' : 'No restado de tus ingresos';
      break;
  }

  const label = TYPE_LABELS[m.type] ?? m.type;
  const title = m.note ? `${label} · ${m.note}` : label;

  let amount = formatMoney(m.amount);
  let kind = '';
  if (effect > 0) {
    amount = `+ ${amount}`;
    kind = 'in';
  } else if (effect < 0) {
    amount = `− ${amount}`;
    kind = 'out';
  }

  return { title, detail, amount, kind };
}

/** Próximos pagos de deudas y cobros de interés, el más cercano primero. */
function upcomingItems(today) {
  const items = [];

  for (const debt of getItems('debts')) {
    const info = describeDebt(debt, today);
    if (info.balance > 0) {
      items.push({ date: info.nextDue, title: `Pagar · ${debt.concept}`, amount: info.nextAmount, kind: 'out' });
    }
  }

  for (const loan of getItems('loans')) {
    if (!loan.hasInterest) continue;
    const info = describeLoan(loan, today);
    if (info.outstanding > 0) {
      items.push({ date: info.nextDue, title: `Cobrar interés · ${loan.person}`, amount: info.interestNext, kind: 'in' });
    }
  }

  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return items;
}

/* =========================================================
   3. BLOQUES DE LA PANTALLA
   ========================================================= */

function buildMonthNav(container, month, earliest, current) {
  const nav = el('div', '', 'month-nav span-all');

  const prev = el('button', '‹', 'btn-small btn-small--outline');
  prev.type = 'button';
  prev.setAttribute('aria-label', 'Mes anterior');
  prev.disabled = month <= earliest;
  prev.addEventListener('click', () => {
    shownMonth = shiftMonth(month, -1);
    draw(container);
  });

  const next = el('button', '›', 'btn-small btn-small--outline');
  next.type = 'button';
  next.setAttribute('aria-label', 'Mes siguiente');
  next.disabled = month >= current;
  next.addEventListener('click', () => {
    shownMonth = shiftMonth(month, 1);
    draw(container);
  });

  const label = el('div', monthLabel(month), 'month-nav__label');
  label.setAttribute('aria-live', 'polite');

  nav.append(prev, label, next);
  return nav;
}

function buildIncomeCard(month, isCurrent, totals) {
  const card = el('section', '', 'card');
  card.appendChild(el('h2', 'Ingresos y gastos'));

  const list = el('div', '', 'sum-list');
  list.appendChild(sumRow('Viene del mes anterior', formatMoney(getCarryOver(month))));

  const add = (label, amount, kind, always = false) => {
    if (amount > 0 || always) {
      list.appendChild(sumRow(label, `${kind === 'in' ? '+' : '−'} ${formatMoney(amount)}`, kind));
    }
  };
  add('Ingresos', totals.ingresos, 'in', true);
  add('Retiros de ahorros', totals.retiros, 'in');
  add('Cobros de préstamos', totals.cobros, 'in');
  add('Gastos', totals.gastos, 'out', true);
  add('Ahorros restados de ingresos', totals.ahorros, 'out');
  add('Pagos de deudas', totals.pagosDeuda, 'out');
  add('Préstamos que diste', totals.prestamos, 'out');

  list.appendChild(
    sumRow(isCurrent ? 'Disponible ahora' : 'Disponible al cierre', formatMoney(getAvailableIncome(month)), 'total')
  );
  card.appendChild(list);
  return card;
}

function buildSavingsCard(month, isCurrent, totals, movements) {
  const card = el('section', '', 'card');
  card.appendChild(el('h2', 'Ahorros'));

  const list = el('div', '', 'sum-list');
  list.appendChild(sumRow('Ahorrado en el mes', `+ ${formatMoney(totals.savedTotal)}`, 'in'));
  list.appendChild(sumRow('Retirado en el mes', `− ${formatMoney(totals.retiros)}`, 'out'));
  list.appendChild(
    sumRow(isCurrent ? 'Ahorro actual' : 'Ahorro al cierre', formatMoney(savingsUntil(month, movements)), 'total')
  );
  card.appendChild(list);
  return card;
}

function buildDebtsCard(today, totals) {
  const card = el('section', '', 'card');
  card.appendChild(el('h2', 'Mis deudas'));

  const debts = getItems('debts').map((debt) => describeDebt(debt, today));
  if (debts.length === 0) {
    card.appendChild(el('p', 'No tienes deudas registradas.', 'card__total'));
    if (totals.debtPaidTotal > 0) {
      const list = el('div', '', 'sum-list');
      list.appendChild(sumRow('Pagado en el mes', formatMoney(totals.debtPaidTotal)));
      card.appendChild(list);
    }
    return card;
  }

  const totalLeft = roundMoney(debts.reduce((sum, info) => sum + info.remaining, 0));
  const overdue = debts.filter((info) => daysBetween(today, info.nextDue) < 0).length;

  const list = el('div', '', 'sum-list');
  list.appendChild(sumRow(`Debo en total (${debts.length} ${plural(debts.length, 'deuda', 'deudas')})`, formatMoney(totalLeft), 'total'));
  list.appendChild(sumRow('Pagado en el mes', formatMoney(totals.debtPaidTotal)));
  if (overdue > 0) {
    list.appendChild(sumRow('Con pago vencido', `${overdue} ${plural(overdue, 'deuda', 'deudas')}`, 'out'));
  }
  card.appendChild(list);
  return card;
}

function buildLoansCard(today, totals) {
  const card = el('section', '', 'card');
  card.appendChild(el('h2', 'Mis préstamos'));

  const loans = getItems('loans').map((loan) => describeLoan(loan, today));
  if (loans.length === 0) {
    card.appendChild(el('p', 'No tienes préstamos registrados.', 'card__total'));
    if (totals.collectedTotal > 0) {
      const list = el('div', '', 'sum-list');
      list.appendChild(sumRow('Cobrado en el mes', formatMoney(totals.collectedTotal)));
      card.appendChild(list);
    }
    return card;
  }

  const totalOwed = roundMoney(loans.reduce((sum, info) => sum + info.outstanding, 0));
  const overdueInterest = roundMoney(loans.reduce((sum, info) => sum + info.pending * info.interestNext, 0));

  const list = el('div', '', 'sum-list');
  list.appendChild(sumRow(`Me deben en total (${loans.length} ${plural(loans.length, 'préstamo', 'préstamos')})`, formatMoney(totalOwed), 'total'));
  list.appendChild(sumRow('Cobrado en el mes', formatMoney(totals.collectedTotal)));
  list.appendChild(sumRow('   De capital', formatMoney(totals.principalCollected)));
  list.appendChild(sumRow('   De intereses (tu ganancia)', formatMoney(totals.interestCollected), 'in'));
  if (totals.loanedTotal > 0) {
    list.appendChild(sumRow('Prestado en el mes', formatMoney(totals.loanedTotal)));
  }
  if (overdueInterest > 0) {
    list.appendChild(sumRow('Intereses vencidos', formatMoney(overdueInterest), 'out'));
  }
  card.appendChild(list);
  return card;
}

function buildUpcomingCard(today) {
  const card = el('section', '', 'card span-all');
  card.appendChild(el('h2', 'Lo que viene'));

  const items = upcomingItems(today);
  if (items.length === 0) {
    card.appendChild(el('p', 'No hay pagos ni cobros pendientes.', 'card__total'));
    return card;
  }

  const list = el('ul', '', 'move-list');
  for (const item of items.slice(0, MAX_UPCOMING)) {
    const days = daysBetween(today, item.date);
    let sub;
    let late = false;
    if (days < 0) {
      sub = `Vencido hace ${-days} ${plural(-days, 'día', 'días')} · ${formatShortDate(item.date)}`;
      late = true;
    } else if (days === 0) {
      sub = 'Hoy';
    } else {
      sub = `${formatShortDate(item.date)} · en ${days} ${plural(days, 'día', 'días')}`;
    }

    const li = el('li', '', 'move');
    const main = el('div', '', 'move__main');
    main.append(el('div', item.title, 'move__title'), el('div', sub, `move__sub${late ? ' move__sub--late' : ''}`));
    li.append(main, el('span', formatMoney(item.amount), `move__amount move__amount--${item.kind}`));
    list.appendChild(li);
  }
  card.appendChild(list);

  if (items.length > MAX_UPCOMING) {
    const more = items.length - MAX_UPCOMING;
    card.appendChild(el('p', `Y ${more} más.`, 'card__total'));
  }
  return card;
}

function buildMovementsCard(month, movements) {
  const card = el('section', '', 'card span-all');
  card.appendChild(el('h2', `Movimientos de ${monthLabel(month)}`));

  // El más reciente primero (el orden dentro del mismo día es el de captura, al revés)
  const list = movements
    .filter((m) => monthKey(m.date) === month)
    .reverse()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  if (list.length === 0) {
    card.appendChild(el('p', 'No hay movimientos en este mes.', 'card__total'));
    return card;
  }

  const ul = el('ul', '', 'move-list');
  for (const m of list.slice(0, MAX_MOVEMENTS)) {
    const d = describeMovement(m);
    const li = el('li', '', 'move');
    const main = el('div', '', 'move__main');
    main.append(el('div', d.title, 'move__title'), el('div', `${formatShortDate(m.date)} · ${d.detail}`, 'move__sub'));
    li.append(main, el('span', d.amount, `move__amount${d.kind ? ` move__amount--${d.kind}` : ''}`));
    ul.appendChild(li);
  }
  card.appendChild(ul);

  if (list.length > MAX_MOVEMENTS) {
    card.appendChild(el('p', `Mostrando los ${MAX_MOVEMENTS} más recientes de ${list.length}.`, 'card__total'));
  }
  return card;
}

/* =========================================================
   4. DIBUJAR LA PANTALLA
   ========================================================= */

function draw(container) {
  clear(container);

  const today = todayISO();
  const current = monthKey(today);
  const movements = getItems('transactions');
  const month = shownMonth;
  const isCurrent = month === current;

  // El mes más antiguo que se puede ver: el del primer movimiento
  let earliest = current;
  for (const m of movements) {
    const key = monthKey(m.date);
    if (key < earliest) earliest = key;
  }

  const totals = summarizeMonth(month, movements);

  container.append(
    buildMonthNav(container, month, earliest, current),
    buildIncomeCard(month, isCurrent, totals),
    buildSavingsCard(month, isCurrent, totals, movements),
    buildDebtsCard(today, totals),
    buildLoansCard(today, totals),
    buildUpcomingCard(today),
    buildMovementsCard(month, movements)
  );
}

/** Se llama cada vez que abres Resumen: empieza en el mes actual. */
export function renderSummary(container) {
  shownMonth = monthKey(todayISO());
  draw(container);
}