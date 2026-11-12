/* =========================================================
   protect.js
   Todo lo que ve la persona sobre la protección de sus datos:
     - Aviso en Inicio (uno a la vez, el más importante):
         · "Recuperamos tus datos" (después de una recuperación)
         · "Tu navegador no deja guardar datos"
         · "Instala la app" (si se usa dentro del navegador)
         · "Hace X días que no descargas un respaldo"
     - Mensajes claros cuando guardar falla.
     - Tarjeta "Protección de tus datos" en Ajustes.
   La lógica y el acceso a los datos viven en storage.js y vault.js.
   ========================================================= */

import { downloadExcel, downloadPdf } from './export.js';
import {
  canStoreData,
  getBackupStatus,
  getPersistenceInfo,
  getVaultInfo,
  isNoticeSnoozed,
  requestPersistence,
  snoozeNotice,
} from './storage.js';
import { showDialog, showToast } from './ui.js';
import { el } from './utils.js';

const BACKUP_SNOOZE_DAYS = 3;
const INSTALL_SNOOZE_DAYS = 7;

/* =========================================================
   1. ¿DÓNDE ESTÁ CORRIENDO LA APP?
   ========================================================= */

/** ¿Está instalada (abierta desde el ícono de la pantalla de inicio)? */
function isInstalled() {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
  } catch {
    /* sin matchMedia */
  }
  return navigator.standalone === true; // Safari en iPhone
}

function isIPhone() {
  const ua = navigator.userAgent || '';
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/i.test(ua) || iPadOS;
}

function isAndroid() {
  return /Android/i.test(navigator.userAgent || '');
}

// Chrome y Brave de Android avisan cuando se puede instalar; guardamos el aviso para ofrecer el botón
let installPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  refreshNotice();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  refreshNotice();
});

/** Pasos para instalar, según el teléfono. */
function installSteps() {
  if (isIPhone()) return 'Toca el botón Compartir de Safari y luego «Agregar a inicio».';
  return 'Abre el menú ⋮ del navegador y elige «Instalar app» o «Agregar a pantalla de inicio».';
}

/* =========================================================
   2. AVISO EN INICIO (un solo aviso a la vez)
   ========================================================= */

let recoveredInfo = null; // lo llena announceRecovery() cuando se recuperaron datos

/** Decide qué aviso toca mostrar ahora (o null si ninguno). */
function pickNotice() {
  if (recoveredInfo) {
    return {
      kind: 'recovered',
      text: `Se recuperaron tus datos (${recoveredInfo.records} registros) desde la copia interna de la app. Descarga un respaldo cuando puedas.`,
      action: 'Descargar',
      later: 'Entendido',
    };
  }
  if (!canStoreData()) {
    return {
      kind: 'blocked',
      text: 'Tu navegador no deja guardar datos (puede ser el modo privado). Lo que registres se perderá al cerrar. Abre la app en una ventana normal.',
    };
  }
  if ((isIPhone() || isAndroid()) && !isInstalled() && !isNoticeSnoozed('install')) {
    return {
      kind: 'install',
      text: installPrompt
        ? 'Instala la app para que el navegador cuide mejor tus datos.'
        : `Instala la app para que el navegador cuide mejor tus datos. ${installSteps()}`,
      action: installPrompt ? 'Instalar' : null,
      later: 'Más tarde',
    };
  }
  const backup = getBackupStatus();
  if (backup.due) {
    const when = backup.daysSince === null ? 'Todavía no has descargado un respaldo.' : `Hace ${backup.daysSince} días que no descargas un respaldo.`;
    return {
      kind: 'backup',
      text: `${when} Descárgalo para no perder tu información.`,
      action: 'Descargar',
      later: 'Más tarde',
    };
  }
  return null;
}

let currentNotice = null;

function refreshNotice() {
  const box = document.getElementById('home-notice');
  const text = document.getElementById('home-notice-text');
  const action = document.getElementById('home-notice-action');
  const later = document.getElementById('home-notice-later');
  if (!box || !text || !action || !later) return;

  currentNotice = pickNotice();
  box.hidden = !currentNotice;
  if (!currentNotice) return;

  box.dataset.kind = currentNotice.kind;
  text.textContent = currentNotice.text;
  action.hidden = !currentNotice.action;
  action.textContent = currentNotice.action ?? '';
  later.hidden = !currentNotice.later;
  later.textContent = currentNotice.later ?? '';
}

/** Abre la hoja del reporte (donde se descargan el PDF y el Excel). */
function openReportSheet() {
  const dialog = document.getElementById('sheet-reporte');
  if (dialog && typeof dialog.showModal === 'function' && !dialog.open) {
    dialog.classList.remove('is-closing');
    showDialog(dialog);
  }
}

async function onNoticeAction() {
  if (!currentNotice) return;
  if (currentNotice.kind === 'install' && installPrompt) {
    const prompt = installPrompt;
    installPrompt = null;
    try {
      await prompt.prompt();
    } catch {
      /* la persona canceló */
    }
    refreshNotice();
    return;
  }
  // 'recovered' y 'backup': ir a descargar el respaldo
  openReportSheet();
}

function onNoticeLater() {
  if (!currentNotice) return;
  if (currentNotice.kind === 'recovered') recoveredInfo = null;
  else if (currentNotice.kind === 'backup') snoozeNotice('backup', BACKUP_SNOOZE_DAYS);
  else if (currentNotice.kind === 'install') snoozeNotice('install', INSTALL_SNOOZE_DAYS);
  refreshNotice();
}

/** main.js lo llama si al abrir se recuperaron datos de la copia interna. */
export function announceRecovery(result) {
  if (!result) return;
  recoveredInfo = { records: result.records };
  refreshNotice();
}

/* =========================================================
   3. MENSAJES CUANDO GUARDAR FALLA
   ========================================================= */

const SAVE_FAILURE_TEXT = {
  full: 'No se pudo guardar: tu teléfono ya no tiene espacio para la app. Libera espacio y descarga un respaldo.',
  blocked: 'No se pudo guardar: tu navegador está bloqueando el almacenamiento (¿modo privado?). Abre la app en una ventana normal.',
  other: 'No se pudo guardar. Descarga un respaldo e intenta de nuevo.',
};

/* =========================================================
   4. ARRANQUE
   ========================================================= */

export function initProtection() {
  document.getElementById('home-notice-action')?.addEventListener('click', onNoticeAction);
  document.getElementById('home-notice-later')?.addEventListener('click', onNoticeLater);

  document.addEventListener('finanzas:guardado-fallo', (event) => {
    showToast(SAVE_FAILURE_TEXT[event.detail] ?? SAVE_FAILURE_TEXT.other, 'error');
  });
  document.addEventListener('finanzas:respaldo', refreshNotice);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshNotice();
  });
  // Se revisa cada vez que cambias de pantalla (por si ya toca el recordatorio)
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(refreshNotice).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
  }
  refreshNotice();
}

/* =========================================================
   5. TARJETA "PROTECCIÓN DE TUS DATOS" (Ajustes)
   ========================================================= */

const dateTimeFormatter = new Intl.DateTimeFormat('es-MX', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** 1234567 -> "1.2 MB" */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function backupText(status) {
  if (status.daysSince === null) return 'Último respaldo descargado: todavía ninguno.';
  if (status.daysSince === 0) return 'Último respaldo descargado: hoy.';
  if (status.daysSince === 1) return 'Último respaldo descargado: ayer.';
  return `Último respaldo descargado: hace ${status.daysSince} días.`;
}

/** Botón de descarga de respaldo (PDF o Excel con TODO el historial). */
function backupDownloadButton(label, run, onDone) {
  const button = el('button', label, 'btn-secondary');
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Preparando…';
    try {
      await run();
      onDone();
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

export function buildProtectionCard() {
  const card = el('section', '', 'card');
  card.appendChild(el('h2', 'Protección de tus datos'));

  const persistLine = el('p', 'Almacenamiento protegido: revisando…', 'card__total');
  const spaceLine = el('p', '', 'card__total');
  spaceLine.hidden = true;
  const installLine = el('p', '', 'card__total');
  const vaultLine = el('p', 'Copia interna: revisando…', 'card__total');
  const backupLine = el('p', backupText(getBackupStatus()), 'card__total');
  card.append(persistLine, spaceLine, installLine, vaultLine, backupLine);

  // Instalada o no
  if (isInstalled()) {
    installLine.textContent = 'App instalada: sí ✓';
  } else if (isIPhone() || isAndroid()) {
    installLine.textContent = `App instalada: no. Instálala para proteger mejor tus datos. ${installSteps()}`;
  } else {
    installLine.hidden = true;
  }

  const refreshBackupLine = () => {
    backupLine.textContent = backupText(getBackupStatus());
  };

  const requestButton = el('button', 'Pedir protección al navegador', 'btn-secondary');
  requestButton.type = 'button';
  requestButton.hidden = true;
  requestButton.addEventListener('click', async () => {
    requestButton.disabled = true;
    const granted = await requestPersistence();
    requestButton.disabled = false;
    if (granted) {
      showToast('Listo: el navegador protegerá tus datos.');
    } else {
      showToast('El navegador no la concedió. Instala la app y vuelve a intentar.', 'error');
    }
    await fillStatus();
  });

  /** Llena las líneas que dependen del navegador. */
  async function fillStatus() {
    const [info, vaultSavedAt] = await Promise.all([getPersistenceInfo(), getVaultInfo()]);

    if (!info.supported) {
      persistLine.textContent = 'Almacenamiento protegido: este navegador no permite pedir protección.';
    } else if (info.persisted) {
      persistLine.textContent = 'Almacenamiento protegido: sí ✓ El navegador no borrará tus datos para liberar espacio.';
    } else {
      persistLine.textContent = 'Almacenamiento protegido: no garantizado. Si al teléfono le falta espacio, el navegador podría borrar los datos.';
    }
    requestButton.hidden = !(info.supported && !info.persisted);

    if (info.usage !== null && formatBytes(info.usage)) {
      spaceLine.textContent = `Espacio que usa la app: ${formatBytes(info.usage)}.`;
      spaceLine.hidden = false;
    }

    vaultLine.textContent = vaultSavedAt
      ? `Copia interna: guardada el ${dateTimeFormatter.format(new Date(vaultSavedAt))}. Si el navegador vacía los datos por error, la app se recupera sola.`
      : 'Copia interna: todavía no hay (se crea al guardar tus datos).';
    backupLine.textContent = backupText(getBackupStatus());
  }
  fillStatus().catch(() => {
    persistLine.textContent = 'Almacenamiento protegido: no se pudo revisar.';
    vaultLine.textContent = 'Copia interna: no se pudo revisar.';
  });

  card.appendChild(
    el(
      'p',
      'Importante: si borras los «datos del sitio» o los «datos de navegación» desde los ajustes del navegador, se pierde TODO, también la copia interna. Solo un PDF o Excel guardado fuera de la app te protege de eso. Borrar solo el caché no toca tus datos.',
      'interest-preview'
    )
  );

  card.appendChild(requestButton);
  const row = el('div', '', 'actions-row');
  row.append(
    backupDownloadButton('Respaldo en PDF', () => downloadPdf(), refreshBackupLine),
    backupDownloadButton('Respaldo en Excel', () => downloadExcel(), refreshBackupLine)
  );
  card.appendChild(row);
  return card;
}
