/* =========================================================
   export.js  (versión CON librerías)
   Genera el PDF y el Excel con tus datos.
     - PDF:   jsPDF + jsPDF-AutoTable      (carpeta lib/)
     - Excel: write-excel-file (sin Web Workers)  (carpeta lib/)
   Las librerías NO se cargan al abrir la app: solo cuando
   tocas "Descargar PDF" o "Descargar Excel".
   Solo LEE los datos: no guarda ni cambia nada.
   ========================================================= */

import { BACKUP_SHEET, backupExcelCells, createBackupPayload, embedBackupInPdf } from './backup.js';
import { describeDebt } from './debts.js';
import { describeLoan } from './loans.js';
import { loadLib } from './libs.js';
import { getItems } from './storage.js';
import { getAvailableIncome, getSavingBalance, incomeEffect } from './transactions.js';
import { showToast } from './ui.js';
import {
  FREQUENCY_LABELS,
  formatMoney,
  formatShortDate,
  monthKey,
  parseISODate,
  roundMoney,
  todayISO,
} from './utils.js';

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

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/; // "2026-11"

const monthFormatter = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' });

/* =========================================================
   1. LIBRERÍAS (se cargan solo cuando hacen falta, ver libs.js)
   ========================================================= */

async function loadPdfLibraries() {
  await loadLib('jspdf.umd.min.js');
  await loadLib('jspdf.plugin.autotable.min.js'); // se engancha a jsPDF al cargarse
  return window.jspdf.jsPDF;
}

async function loadExcelLibrary() {
  await loadLib('xlsx-writer.min.js');
  return window.writeXlsxSync;
}

/* =========================================================
   2. DATOS DEL REPORTE (se calculan una vez; PDF y Excel usan lo mismo)
   ========================================================= */

function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  const text = monthFormatter.format(new Date(year, month - 1, 1));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Ordena de más reciente a más antiguo; en el mismo día, lo último capturado va primero. */
function sortedMovements() {
  return getItems('transactions')
    .reverse()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function buildMonths(movements, today) {
  const current = monthKey(today);
  let earliest = current;
  for (const m of movements) {
    if (monthKey(m.date) < earliest) earliest = monthKey(m.date);
  }

  const rows = [];
  let [year, month] = earliest.split('-').map(Number);
  // Tope de seguridad: 50 años de meses
  for (let i = 0; i < 600; i++) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    if (key > current) break;

    let ingresos = 0;
    let gastos = 0;
    let ahorrado = 0;
    for (const m of movements) {
      if (monthKey(m.date) !== key) continue;
      if (m.type === 'ingreso') ingresos += m.amount;
      else if (m.type === 'gasto') gastos += m.amount;
      else if (m.type === 'ahorro') ahorrado += m.amount;
    }
    rows.push({
      key,
      label: monthLabel(key),
      ingresos: roundMoney(ingresos),
      gastos: roundMoney(gastos),
      ahorrado: roundMoney(ahorrado),
      disponible: getAvailableIncome(key),
    });

    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return rows.reverse(); // el mes más reciente primero
}

/** period = "2026-11" para un solo mes; null para todos los meses. */
function buildReport(period = null) {
  const periodKey = typeof period === 'string' && MONTH_KEY.test(period) ? period : null;
  const today = todayISO();
  const allMovements = sortedMovements();
  const movements = periodKey ? allMovements.filter((m) => monthKey(m.date) === periodKey) : allMovements;

  const debts = getItems('debts').map((debt) => ({ debt, info: describeDebt(debt, today) }));
  const loans = getItems('loans').map((loan) => ({ loan, info: describeLoan(loan, today) }));

  const owe = roundMoney(debts.reduce((sum, d) => sum + d.info.remaining, 0));
  const owed = roundMoney(loans.reduce((sum, l) => sum + l.info.outstanding, 0));
  const interestEarned = roundMoney(loans.reduce((sum, l) => sum + l.info.interestCollected, 0));

  return {
    today,
    periodKey,
    period: periodKey ? monthLabel(periodKey) : '',
    summary: [
      ['Disponible para gastar', getAvailableIncome()],
      ['Ahorro actual', getSavingBalance()],
      ['Debo en total', owe],
      ['Me deben en total', owed],
      ['Intereses cobrados (ganancia)', interestEarned],
    ],
    months: buildMonths(allMovements, today).filter((row) => !periodKey || row.key === periodKey),
    movements: movements.map((m) => ({
      date: m.date,
      type: TYPE_LABELS[m.type] ?? m.type,
      note: m.note,
      amount: m.amount,
      effect: incomeEffect(m),
    })),
    debts: debts.map(({ debt, info }) => ({
      concept: debt.concept,
      total: debt.total,
      payment: debt.payment,
      frequency: FREQUENCY_LABELS[debt.frequency] ?? debt.frequency,
      paid: info.paid,
      balance: info.balance,
      remaining: info.remaining,
      nextDue: info.balance > 0 ? info.nextDue : '',
      pending: info.balance > 0 ? info.pending : 0,
      status: info.balance > 0 ? (info.pending > 0 ? 'Pago vencido' : 'Al corriente') : 'Liquidada',
    })),
    loans: loans.map(({ loan, info }) => ({
      person: loan.person,
      date: loan.date,
      amount: loan.amount,
      rate: loan.hasInterest ? loan.rate : 0,
      frequency: loan.hasInterest ? (FREQUENCY_LABELS[loan.frequency] ?? loan.frequency) : 'Sin interés',
      recovered: info.recovered,
      outstanding: info.outstanding,
      interestCollected: info.interestCollected,
      nextDue: loan.hasInterest && info.outstanding > 0 ? info.nextDue : '',
      status: info.outstanding > 0 ? (info.pending > 0 ? 'Cobro vencido' : 'Activo') : 'Cobrado',
    })),
  };
}

/* =========================================================
   3. ENTREGAR EL ARCHIVO
   En teléfono se abre la hoja de "Compartir" (Guardar en Archivos,
   AirDrop, WhatsApp...). En computadora se descarga directo.
   ========================================================= */

/** ¿Es un teléfono o tableta? En computadora el archivo se descarga directo. */
function isTouchDevice() {
  const ua = navigator.userAgent || '';
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod|Android/i.test(ua) || iPadOS;
}

/** Devuelve true si el archivo se entregó, o false si cerraste la hoja de Compartir sin guardarlo. */
async function deliver(blob, fileName, mimeType) {
  const file = new File([blob], fileName, { type: mimeType });

  if (isTouchDevice() && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return true;
    } catch (error) {
      if (error && error.name === 'AbortError') return false; // cerraste la hoja de compartir
      // Cualquier otro fallo: se intenta la descarga normal
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  return true;
}

function fileName(extension, periodKey = null) {
  return `finanzas-${periodKey || todayISO()}.${extension}`;
}

/* =========================================================
   4. PDF
   ========================================================= */

const PDF_BLUE = [76, 125, 255];
const PDF_MARGIN = 14;

async function buildPdf(report) {
  const JsPDF = await loadPdfLibraries();
  const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();

  let y = 18;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('Mis Finanzas', PDF_MARGIN, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(
    report.period
      ? `Reporte de ${report.period} · generado el ${formatShortDate(report.today)}`
      : `Reporte al ${formatShortDate(report.today)}`,
    PDF_MARGIN,
    y
  );
  y += 4.5;
  doc.setFontSize(8);
  doc.text('Este PDF incluye un respaldo: puedes restaurar tus datos en la app (Ajustes > Restaurar mis datos).', PDF_MARGIN, y);
  doc.setTextColor(0);
  y += 7;

  /** Título de sección; salta de página si queda muy poco espacio. */
  const heading = (text) => {
    if (y > pageHeight - 40) {
      doc.addPage();
      y = 18;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(text, PDF_MARGIN, y);
    y += 3;
  };

  const emptyNote = (text) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(text, PDF_MARGIN, y + 4);
    doc.setTextColor(0);
    y += 12;
  };

  const table = (head, body, options = {}) => {
    doc.autoTable({
      startY: y,
      head: [head],
      body,
      margin: { left: PDF_MARGIN, right: PDF_MARGIN },
      styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.8, overflow: 'linebreak' },
      headStyles: { fillColor: PDF_BLUE, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 247, 251] },
      ...options,
    });
    y = doc.lastAutoTable.finalY + 9;
  };

  const right = { halign: 'right' };

  // 1. Resumen
  heading('Resumen de hoy');
  table(
    ['Concepto', 'Cantidad'],
    report.summary.map(([label, value]) => [label, formatMoney(value)]),
    { columnStyles: { 1: right }, didParseCell: (d) => d.section === 'head' && d.column.index === 1 && (d.cell.styles.halign = 'right') }
  );

  // 2. Por mes
  heading('Por mes');
  table(
    ['Mes', 'Ingresos', 'Gastos', 'Ahorrado', 'Disponible al cierre'],
    report.months.map((m) => [m.label, formatMoney(m.ingresos), formatMoney(m.gastos), formatMoney(m.ahorrado), formatMoney(m.disponible)]),
    {
      columnStyles: { 1: right, 2: right, 3: right, 4: right },
      didParseCell: (d) => d.section === 'head' && d.column.index > 0 && (d.cell.styles.halign = 'right'),
    }
  );

  // 3. Deudas
  heading('Deudas');
  if (report.debts.length === 0) {
    emptyNote('No hay deudas registradas.');
  } else {
    table(
      ['Concepto', 'Total', 'Pago', 'Frecuencia', 'Pagado', 'Falta pagar', 'Próximo pago', 'Estado'],
      report.debts.map((d) => [
        d.concept,
        formatMoney(d.total),
        formatMoney(d.payment),
        d.frequency,
        formatMoney(d.paid),
        formatMoney(d.remaining),
        d.nextDue ? formatShortDate(d.nextDue) : '-',
        d.status,
      ]),
      {
        columnStyles: { 1: right, 2: right, 4: right, 5: right },
        didParseCell: (d) => d.section === 'head' && [1, 2, 4, 5].includes(d.column.index) && (d.cell.styles.halign = 'right'),
      }
    );
  }

  // 4. Préstamos
  heading('Préstamos');
  if (report.loans.length === 0) {
    emptyNote('No hay préstamos registrados.');
  } else {
    table(
      ['Persona', 'Fecha', 'Prestado', 'Interés', 'Recuperado', 'Me deben', 'Interés cobrado', 'Estado'],
      report.loans.map((l) => [
        l.person,
        formatShortDate(l.date),
        formatMoney(l.amount),
        l.rate > 0 ? `${l.rate}% ${l.frequency.toLowerCase()}` : l.frequency,
        formatMoney(l.recovered),
        formatMoney(l.outstanding),
        formatMoney(l.interestCollected),
        l.status,
      ]),
      {
        columnStyles: { 2: right, 4: right, 5: right, 6: right },
        didParseCell: (d) => d.section === 'head' && [2, 4, 5, 6].includes(d.column.index) && (d.cell.styles.halign = 'right'),
      }
    );
  }

  // 5. Movimientos
  heading('Movimientos');
  if (report.movements.length === 0) {
    emptyNote('Todavía no hay movimientos.');
  } else {
    table(
      ['Fecha', 'Tipo', 'Detalle', 'Cantidad', 'Efecto en ingresos'],
      report.movements.map((m) => [
        formatShortDate(m.date),
        m.type,
        m.note || '-',
        formatMoney(m.amount),
        m.effect === 0 ? '-' : `${m.effect > 0 ? '+' : '-'} ${formatMoney(Math.abs(m.effect))}`,
      ]),
      {
        columnStyles: { 3: right, 4: right },
        didParseCell: (d) => {
          if (d.section === 'head' && d.column.index >= 3) d.cell.styles.halign = 'right';
          if (d.section === 'body' && d.column.index === 4) {
            const text = String(d.cell.raw);
            if (text.startsWith('+')) d.cell.styles.textColor = [26, 140, 74];
            else if (text.startsWith('-') && text.length > 1) d.cell.styles.textColor = [200, 50, 50];
          }
        },
      }
    );
  }

  // Número de página en cada hoja
  const pages = doc.getNumberOfPages();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(130);
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.text(`Página ${i} de ${pages}`, pageWidth / 2, pageHeight - 8, { align: 'center' });
  }

  // Respaldo completo de tus datos, escondido dentro del PDF (sirve para restaurar)
  embedBackupInPdf(doc, await createBackupPayload());

  return doc.output('blob');
}

/* =========================================================
   5. EXCEL
   ========================================================= */

const MONEY_FORMAT = '$#,##0.00';
const DATE_FORMAT = 'dd/mm/yyyy';

const HEADER = { fontWeight: 'bold', backgroundColor: '#4c7dff', textColor: '#ffffff' };
const head = (text, align) => ({ value: text, ...HEADER, ...(align ? { align } : {}) });
const text = (value) => ({ value: value === '' || value == null ? null : String(value), type: String });
const money = (value) => ({ value, type: Number, format: MONEY_FORMAT });
const percent = (value) => ({ value, type: Number, format: '0.00"%"' });
const date = (iso) => {
  const parsed = parseISODate(iso);
  return parsed ? { value: parsed, type: Date, format: DATE_FORMAT } : { value: null };
};

async function buildExcel(report) {
  const writeXlsx = await loadExcelLibrary();

  // Hoja 1: Resumen
  const summaryRows = [
    [head('Concepto'), head('Cantidad', 'right')],
    ...report.summary.map(([label, value]) => [text(label), money(value)]),
    [{ value: null }],
    [head('Mes'), head('Ingresos', 'right'), head('Gastos', 'right'), head('Ahorrado', 'right'), head('Disponible al cierre', 'right')],
    ...report.months.map((m) => [text(m.label), money(m.ingresos), money(m.gastos), money(m.ahorrado), money(m.disponible)]),
  ];

  // Hoja 2: Movimientos
  const movementRows = [
    [head('Fecha'), head('Tipo'), head('Detalle'), head('Cantidad', 'right'), head('Efecto en ingresos', 'right')],
    ...(report.movements.length === 0 ? [[text('Todavía no hay movimientos.')]] : []),
    ...report.movements.map((m) => [date(m.date), text(m.type), text(m.note), money(m.amount), money(m.effect)]),
  ];

  // Hoja 3: Deudas
  const debtRows = [
    [head('Concepto'), head('Total a pagar', 'right'), head('Pago', 'right'), head('Frecuencia'), head('Pagado', 'right'), head('Capital pendiente', 'right'), head('Falta por pagar', 'right'), head('Próximo pago'), head('Pagos vencidos', 'right'), head('Estado')],
    ...(report.debts.length === 0 ? [[text('No hay deudas registradas.')]] : []),
    ...report.debts.map((d) => [
      text(d.concept),
      money(d.total),
      money(d.payment),
      text(d.frequency),
      money(d.paid),
      money(d.balance),
      money(d.remaining),
      date(d.nextDue),
      { value: d.pending, type: Number },
      text(d.status),
    ]),
  ];

  // Hoja 4: Préstamos
  const loanRows = [
    [head('Persona'), head('Fecha'), head('Prestado', 'right'), head('Interés %', 'right'), head('Cobro de interés'), head('Recuperado', 'right'), head('Me deben', 'right'), head('Interés cobrado', 'right'), head('Próximo cobro'), head('Estado')],
    ...(report.loans.length === 0 ? [[text('No hay préstamos registrados.')]] : []),
    ...report.loans.map((l) => [
      text(l.person),
      date(l.date),
      money(l.amount),
      l.rate > 0 ? percent(l.rate) : { value: null },
      text(l.frequency),
      money(l.recovered),
      money(l.outstanding),
      money(l.interestCollected),
      date(l.nextDue),
      text(l.status),
    ]),
  ];

  const widths = (list) => list.map((width) => ({ width }));

  // Hoja "Respaldo": copia completa de tus datos para poder restaurarlos
  const backupRows = [
    [text('Respaldo de Mis Finanzas. No borres ni cambies esta hoja: sirve para restaurar tus datos en la app (Ajustes > Restaurar mis datos).')],
    ...backupExcelCells(await createBackupPayload()).map((cell) => [{ value: cell, type: String }]),
  ];

  const sheets = [
    { sheet: 'Resumen', data: summaryRows, columns: widths([30, 18, 18, 18, 22]), stickyRowsCount: 1 },
    { sheet: 'Movimientos', data: movementRows, columns: widths([13, 20, 32, 16, 20]), stickyRowsCount: 1 },
    { sheet: 'Deudas', data: debtRows, columns: widths([28, 16, 14, 16, 14, 18, 18, 14, 14, 14]), stickyRowsCount: 1 },
    { sheet: 'Préstamos', data: loanRows, columns: widths([24, 13, 14, 11, 18, 14, 14, 16, 14, 14]), stickyRowsCount: 1 },
    { sheet: BACKUP_SHEET, data: backupRows, columns: widths([60]) },
  ];

  return writeXlsx(sheets, {}); // devuelve una promesa con el archivo
}

/* =========================================================
   6. BOTONES
   ========================================================= */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Evita doble toque y muestra "Preparando..." mientras se genera el archivo. */
function wireButton(id, busyText, run) {
  const button = document.getElementById(id);
  if (!button) return;

  const originalText = button.textContent;
  let busy = false;

  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = busyText;
    try {
      await run();
    } catch (error) {
      console.error('Error al exportar:', error);
      showToast('No se pudo generar el archivo. Intenta de nuevo.', 'error');
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = originalText;
    }
  });
}

/** Genera y entrega el PDF. period = "2026-11" (un mes) o nada (todos los meses). Devuelve true si se guardó/compartió. */
export async function downloadPdf(period = null) {
  const report = buildReport(period);
  const blob = await buildPdf(report);
  return deliver(blob, fileName('pdf', report.periodKey), 'application/pdf');
}

/** Genera y entrega el Excel. period = "2026-11" (un mes) o nada (todos los meses). Devuelve true si se guardó/compartió. */
export async function downloadExcel(period = null) {
  const report = buildReport(period);
  const blob = await buildExcel(report);
  return deliver(blob, fileName('xlsx', report.periodKey), XLSX_MIME);
}

/* =========================================================
   6. SELECTOR DE MES (Inicio > Reporte de tus movimientos del mes)
   Por defecto el mes actual. Las flechas recorren los meses con
   movimientos y, al final, "Todos los meses".
   ========================================================= */

const ALL_MONTHS = 'all';
let reportChoice = null; // "2026-11" o ALL_MONTHS; null = mes actual

/** Meses desde el primer movimiento hasta hoy (más antiguo primero) y, al final, "Todos los meses". */
function reportOptions() {
  const current = monthKey(todayISO());
  let earliest = current;
  for (const m of getItems('transactions')) {
    if (monthKey(m.date) < earliest) earliest = monthKey(m.date);
  }
  const options = [];
  let [year, month] = earliest.split('-').map(Number);
  for (let i = 0; i < 600; i++) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    if (key > current) break;
    options.push(key);
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  options.push(ALL_MONTHS);
  return options;
}

/** La opción elegida (si ya no existe, vuelve al mes actual). */
function resolveChoice(options) {
  if (reportChoice && options.includes(reportChoice)) return reportChoice;
  reportChoice = options[options.length - 2]; // el mes actual
  return reportChoice;
}

function drawReportMonth() {
  const label = document.getElementById('report-month-label');
  const prev = document.getElementById('report-prev');
  const next = document.getElementById('report-next');
  if (!label || !prev || !next) return;

  const options = reportOptions();
  const index = options.indexOf(resolveChoice(options));
  label.textContent = reportChoice === ALL_MONTHS ? 'Todos los meses' : monthLabel(reportChoice);
  prev.disabled = index <= 0;
  next.disabled = index >= options.length - 1;
}

function moveReportMonth(step) {
  const options = reportOptions();
  const index = options.indexOf(resolveChoice(options)) + step;
  if (index < 0 || index >= options.length) return;
  reportChoice = options[index];
  drawReportMonth();
}

/** El mes elegido para descargar: "2026-11", o null si eligió "Todos los meses". */
function chosenPeriod() {
  const choice = resolveChoice(reportOptions());
  return choice === ALL_MONTHS ? null : choice;
}

export function initExport() {
  document.getElementById('report-prev')?.addEventListener('click', () => moveReportMonth(-1));
  document.getElementById('report-next')?.addEventListener('click', () => moveReportMonth(1));
  // Se actualiza cada vez que vuelves a Inicio (por si hubo movimientos nuevos o cambió el mes)
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(drawReportMonth).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
  }
  drawReportMonth();

  wireButton('btn-export-pdf', 'Preparando PDF…', () => downloadPdf(chosenPeriod()));
  wireButton('btn-export-xlsx', 'Preparando Excel…', () => downloadExcel(chosenPeriod()));
}
