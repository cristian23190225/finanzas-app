/* =========================================================
   settings.js
   Pantalla de Ajustes (se abre con el engrane de Inicio):
     - Apariencia: modo claro u oscuro.
     - Restaurar mis datos: vuelve a cargar tus movimientos, deudas y
       préstamos desde un PDF o Excel que descargaste de esta app.
     - Aplicación: versión instalada, estado sin internet y actualizar.
     - Borrar mis datos.
   ========================================================= */

import { BackupError, readBackupFile } from './backup.js';
import { refreshCalendar } from './calendar.js';
import { downloadExcel, downloadPdf } from './export.js';
import { clearAllData, getItems, mergeBackup, previewMerge } from './storage.js';
import { PwaError, getAppInfo, updateApp } from './pwa.js';
import { buildProtectionCard } from './protect.js';
import { chooseTheme, getCurrentTheme } from './theme.js';
import { updateDisplays } from './transactions.js';
import { showToast } from './ui.js';
import { clear, el, formatShortDate } from './utils.js';

const THEME_OPTIONS = [
  ['light', 'Modo claro'],
  ['dark', 'Modo oscuro'],
];

// Solo estos tipos de archivo se pueden elegir (y se vuelven a revisar al leerlos)
const ACCEPTED_FILES =
  '.pdf,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/* =========================================================
   1. APARIENCIA
   ========================================================= */

function buildThemeCard() {
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
  return card;
}

/* =========================================================
   2. RESTAURAR MIS DATOS
   ========================================================= */

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "12 movimientos, 1 deuda y 2 préstamos" (solo lo que no sea cero). */
function describeCounts(counts) {
  const parts = [];
  if (counts.transactions > 0) parts.push(plural(counts.transactions, 'movimiento', 'movimientos'));
  if (counts.debts > 0) parts.push(plural(counts.debts, 'deuda', 'deudas'));
  if (counts.loans > 0) parts.push(plural(counts.loans, 'préstamo', 'préstamos'));
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
}

const sum = (counts) => counts.transactions + counts.debts + counts.loans;

/** Lee el archivo, enseña qué trae, pide confirmación y lo agrega. */
async function restoreFromFile(file) {
  const backup = await readBackupFile(file); // rechaza todo lo que no sea un respaldo de esta app

  const preview = previewMerge(backup.data);
  if (!preview) throw new BackupError('El respaldo no tiene un formato válido.');

  if (sum(preview.total) === 0) {
    showToast('El respaldo está vacío: no trae movimientos, deudas ni préstamos.', 'error');
    return;
  }
  if (sum(preview.fresh) === 0) {
    showToast('Todo lo que trae este archivo ya está en la app. No se agregó nada.');
    return;
  }

  const already = sum(preview.total) - sum(preview.fresh);
  const date = backup.exportedAt ? ` del ${formatShortDate(backup.exportedAt)}` : '';
  const message =
    `Este archivo es un respaldo de Mis Finanzas${date}.\n\n` +
    `Se agregarán: ${describeCounts(preview.fresh)}.` +
    (already > 0 ? `\n(${plural(already, 'registro ya está', 'registros ya están')} en la app y no se duplicarán.)` : '') +
    '\n\nLo que ya tienes en la app no se borra. ¿Continuar?';
  if (!window.confirm(message)) return;

  const result = mergeBackup(backup.data);
  if (!result) throw new BackupError('No se pudo guardar. Revisa el espacio de tu teléfono.');

  updateDisplays(); // totales de Inicio
  refreshCalendar(); // el primer movimiento pudo cambiar
  showToast(`Listo: se agregaron ${describeCounts(result.added)}.`);
}

function buildRestoreCard() {
  const card = el('section', '', 'card');
  card.appendChild(el('h2', 'Restaurar mis datos'));
  card.appendChild(
    el(
      'p',
      'Si se borraron tus datos, puedes recuperarlos con un PDF o Excel que hayas descargado desde esta app. ' +
        'Solo se aceptan esos archivos (descargados con la versión actual); cualquier otro se rechaza.',
      'card__total'
    )
  );

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPTED_FILES;
  input.hidden = true;

  const button = el('button', 'Elegir archivo (PDF o Excel)', 'btn-secondary');
  button.type = 'button';
  button.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = ''; // así se puede volver a elegir el mismo archivo
    if (!file) return;

    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Leyendo archivo…';
    try {
      await restoreFromFile(file);
    } catch (error) {
      console.error('Error al restaurar:', error);
      showToast(error instanceof BackupError ? error.message : 'No se pudo leer el archivo.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });

  card.appendChild(button);
  card.appendChild(input);
  return card;
}

/* =========================================================
   3. APLICACIÓN: versión, sin internet y actualizar
   ========================================================= */

/** Texto del estado "sin internet" según lo que diga el service worker. */
function offlineText(info) {
  if (!info.supported) return 'Sin internet: este navegador no lo permite.';
  if (!info.ready) return 'Sin internet: se está preparando. Cierra la app y ábrela de nuevo con internet.';
  if (info.offlineReady) return 'Sin internet: listo ✓ La app abre aunque no tengas conexión.';
  return 'Sin internet: faltan archivos por guardar. Toca el botón de abajo con internet.';
}

function buildAppCard() {
  const card = el('section', '', 'card');
  card.appendChild(el('h2', 'Aplicación'));

  const versionLine = el('p', 'Versión: …', 'card__total');
  const offlineLine = el('p', 'Sin internet: revisando…', 'card__total');
  const updateLine = el('p', '', 'card__total');
  updateLine.hidden = true;
  card.append(versionLine, offlineLine, updateLine);

  // Se llenan cuando el service worker contesta
  getAppInfo()
    .then((info) => {
      versionLine.textContent = info.ready ? `Versión: ${info.version}` : 'Versión: no disponible todavía';
      offlineLine.textContent = offlineText(info);
      if (info.updateWaiting) {
        updateLine.textContent = 'Hay una versión nueva lista: toca el botón de abajo para instalarla.';
        updateLine.hidden = false;
      }
    })
    .catch(() => {
      versionLine.textContent = 'Versión: no disponible';
      offlineLine.textContent = 'Sin internet: no se pudo revisar.';
    });

  card.appendChild(
    el(
      'p',
      'Úsalo si la app se quedó en una versión vieja o algo no carga bien. Necesitas internet. Tus datos no se tocan.',
      'card__total'
    )
  );

  const button = el('button', 'Actualizar archivos de la app', 'btn-secondary');
  button.type = 'button';
  button.addEventListener('click', async () => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Buscando actualización…';
    try {
      const result = await updateApp();
      if (result === 'updating') {
        showToast('Instalando la versión nueva… la app se reiniciará sola.');
      } else {
        showToast('Ya tienes la última versión. Se volvieron a descargar los archivos; reiniciando…');
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch (error) {
      console.error('Error al actualizar la app:', error);
      showToast(error instanceof PwaError ? error.message : 'No se pudo actualizar. Intenta de nuevo.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
  card.appendChild(button);
  return card;
}

/* =========================================================
   4. BORRAR MIS DATOS
   ========================================================= */

/** Cuántos registros hay guardados ahora. */
function currentCounts() {
  return {
    transactions: getItems('transactions').length,
    debts: getItems('debts').length,
    loans: getItems('loans').length,
  };
}

/** Botón de respaldo dentro de la ventana de borrar: genera el archivo y avisa si se guardó. */
function backupButton(label, busyLabel, run, status) {
  const button = el('button', label, 'btn-small');
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = busyLabel;
    try {
      const saved = await run();
      if (saved) {
        status.textContent = `✓ ${label.replace('Descargar ', '')} guardado. Revisa que esté en tu teléfono antes de borrar.`;
        status.hidden = false;
      }
    } catch (error) {
      console.error('Error al descargar el respaldo:', error);
      showToast('No se pudo generar el respaldo. Intenta de nuevo.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
  return button;
}

/** Ventana de confirmación: recomienda descargar un respaldo y pide confirmar dos veces. */
function askDeleteAll() {
  const counts = currentCounts();
  if (sum(counts) === 0) {
    showToast('No tienes datos guardados para borrar.');
    return;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.setAttribute('aria-labelledby', 'delete-dialog-title');

  const form = document.createElement('form');
  form.noValidate = true;
  form.addEventListener('submit', (event) => event.preventDefault());

  const title = el('h2', '¿Borrar todos tus datos?');
  title.id = 'delete-dialog-title';

  const warning = el(
    'p',
    `Se borrarán de este teléfono: ${describeCounts(counts)}. Esto no se puede deshacer.`,
    'card__total'
  );

  const recommendation = el(
    'p',
    'Te recomendamos descargar un respaldo ANTES de borrar. Con ese PDF o Excel podrás recuperar tus datos en Ajustes > Restaurar mis datos.',
    'interest-preview'
  );

  const status = el('p', '', 'card__total');
  status.hidden = true;
  status.setAttribute('role', 'status');

  const row = el('div', '', 'dialog__row');
  row.append(
    backupButton('Descargar PDF', 'Preparando…', downloadPdf, status),
    backupButton('Descargar Excel', 'Preparando…', downloadExcel, status)
  );

  // Segunda confirmación: hay que marcar la casilla para poder borrar
  const confirmLabel = el('label', '', 'check');
  const confirmBox = document.createElement('input');
  confirmBox.type = 'checkbox';
  confirmLabel.appendChild(confirmBox);
  confirmLabel.appendChild(document.createTextNode('Entiendo que se borrará todo y no se puede deshacer.'));

  const deleteButton = el('button', 'Borrar todos mis datos', 'btn-danger');
  deleteButton.type = 'button';
  deleteButton.disabled = true;
  confirmBox.addEventListener('change', () => {
    deleteButton.disabled = !confirmBox.checked;
  });
  deleteButton.addEventListener('click', () => {
    if (!confirmBox.checked) return;
    if (!clearAllData()) {
      showToast('No se pudieron borrar los datos. Intenta de nuevo.', 'error');
      return;
    }
    dialog.close();
    updateDisplays(); // totales de Inicio
    refreshCalendar(); // ya no hay primer movimiento
    showToast('Listo: se borraron todos tus datos.');
  });

  const cancelButton = el('button', 'Cancelar', 'btn-secondary');
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', () => dialog.close());

  form.append(title, warning, recommendation, row, status, confirmLabel, deleteButton, cancelButton);
  dialog.appendChild(form);
  dialog.addEventListener('close', () => dialog.remove());

  document.body.appendChild(dialog);
  dialog.showModal();
}

function buildDeleteCard() {
  const card = el('section', '', 'card');
  card.appendChild(el('h2', 'Borrar mis datos'));
  card.appendChild(
    el(
      'p',
      'Elimina todo lo que la app tiene guardado en este teléfono: movimientos, deudas y préstamos. ' +
        'Antes de borrar te recomendamos descargar un respaldo.',
      'card__total'
    )
  );

  const button = el('button', 'Borrar mis datos…', 'btn-secondary btn-secondary--danger');
  button.type = 'button';
  button.addEventListener('click', askDeleteAll);
  card.appendChild(button);
  return card;
}

/* =========================================================
   5. PANTALLA
   ========================================================= */

export function renderSettings(container) {
  clear(container);

  // Arriba de todo: volver a Inicio (en Ajustes no se ve la barra de pantallas)
  const back = el('button', '← Volver a Inicio', 'btn-secondary');
  back.type = 'button';
  back.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('finanzas:ver', { detail: 'inicio' }));
  });
  container.appendChild(back);

  container.appendChild(buildThemeCard());
  container.appendChild(buildRestoreCard());
  container.appendChild(buildProtectionCard());
  container.appendChild(buildAppCard());
  container.appendChild(buildDeleteCard());
}
