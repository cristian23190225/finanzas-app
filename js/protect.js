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
import { clear, el } from './utils.js';

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

/** Navegadores y pasos para instalar la app (los nombres de los botones pueden variar un poco según la versión). */
const INSTALL_GUIDES = {
  iphone: [
    ['Safari', 'Toca Compartir (el cuadro con la flecha hacia arriba), baja y elige «Agregar a inicio». Luego toca «Agregar».'],
    ['Chrome', 'Toca Compartir (junto a la barra de direcciones) y elige «Agregar a pantalla de inicio». Luego toca «Agregar».'],
    ['Brave', 'Toca el menú ⋯, elige «Compartir» y luego «Agregar a pantalla de inicio». Luego toca «Agregar».'],
    ['Edge', 'Toca el menú ⋯, elige «Compartir» y luego «Agregar a pantalla de inicio». Luego toca «Agregar».'],
    ['Firefox', 'Toca el menú ☰, elige «Compartir» y luego «Agregar a pantalla de inicio». Luego toca «Agregar».'],
  ],
  android: [
    ['Chrome', 'Toca el menú ⋮ y elige «Instalar app» (o «Agregar a pantalla de inicio»). Luego toca «Instalar».'],
    ['Brave', 'Toca el menú ⋮ y elige «Instalar app» (o «Agregar a pantalla de inicio»). Luego toca «Instalar».'],
    ['Edge', 'Toca el menú ≡ y elige «Agregar al teléfono» (o «Instalar app»). Luego confirma.'],
    ['Firefox', 'Toca el menú ⋮ y elige «Instalar» (o «Agregar a pantalla de inicio»). Luego confirma.'],
    ['Samsung Internet', 'Toca el menú ≡, elige «Agregar página a» y luego «Pantalla de inicio». Luego confirma.'],
  ],
};

/** Los navegadores que le tocan a este teléfono. */
function installGuide() {
  return isIPhone() ? INSTALL_GUIDES.iphone : INSTALL_GUIDES.android;
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
      text: 'Instala la app para que el navegador cuide mejor tus datos.',
      action: installPrompt ? 'Instalar' : 'Ver cómo',
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
  if (currentNotice.kind === 'install') {
    // Los pasos están en Ajustes > Protección de tus datos > "Cómo instalar en…"
    document.dispatchEvent(new CustomEvent('finanzas:ver', { detail: 'ajustes' }));
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

/**
 * Botón "Cómo instalar en…": al tocarlo salen los navegadores; al elegir uno,
 * los demás se quitan y abajo salen sus pasos (con un botón para elegir otro).
 */
function buildInstallHelp() {
  const wrapper = el('div', '', 'install-help');
  const toggle = el('button', 'Cómo instalar en…', 'btn-secondary');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');

  const panel = el('div', '', 'install-help__panel');
  panel.hidden = true;

  /** selected = nombre del navegador elegido, o null para ver la lista */
  function draw(selected) {
    clear(panel);
    const guide = installGuide();
    const chosen = guide.find(([name]) => name === selected);

    if (!chosen) {
      const tabs = el('div', '', 'browser-tabs');
      for (const [name] of guide) {
        const tab = el('button', name, 'browser-tab');
        tab.type = 'button';
        tab.setAttribute('aria-pressed', 'false');
        tab.addEventListener('click', () => draw(name));
        tabs.appendChild(tab);
      }
      panel.appendChild(tabs);
      return;
    }

    const tabs = el('div', '', 'browser-tabs');
    const current = el('button', chosen[0], 'browser-tab');
    current.type = 'button';
    current.setAttribute('aria-pressed', 'true');
    current.disabled = true;
    const other = el('button', 'Otro navegador', 'btn-small btn-small--ghost');
    other.type = 'button';
    other.addEventListener('click', () => draw(null));
    tabs.append(current, other);

    const steps = el('p', chosen[1], 'install-help__steps');
    steps.setAttribute('role', 'status');
    panel.append(tabs, steps);
  }

  toggle.addEventListener('click', () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    if (opening) draw(null);
  });

  wrapper.append(toggle, panel);
  return wrapper;
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

  // Instalada o no (los pasos salen con el botón "Cómo instalar en…")
  const showInstallHelp = !isInstalled() && (isIPhone() || isAndroid());
  if (isInstalled()) {
    installLine.textContent = 'App instalada: sí ✓';
  } else if (showInstallHelp) {
    installLine.textContent = 'App instalada: no. Instálala para proteger mejor tus datos.';
  } else {
    installLine.hidden = true;
  }

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
      'Importante: si borras los «datos del sitio» o los «datos de navegación» desde los ajustes del navegador, se pierde TODO, también la copia interna. Solo un PDF o Excel guardado fuera de la app (en Inicio > Descargar reporte) te protege de eso. Borrar solo el caché no toca tus datos.',
      'interest-preview'
    )
  );

  card.appendChild(requestButton);
  if (showInstallHelp) card.appendChild(buildInstallHelp());
  return card;
}
