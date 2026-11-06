/* =========================================================
   pwa.js
   Habla con el service worker (sw.js) para que la app:
     - abra sin internet,
     - avise cuando hay una versión nueva ("Hay una versión nueva. [Actualizar]"),
     - se pueda actualizar a mano desde Ajustes,
     - diga qué versión tiene instalada.
   Tus datos no pasan por aquí: esto solo maneja los ARCHIVOS de la app.
   ========================================================= */

const SW_URL = new URL('../sw.js', import.meta.url).href;
const RECHECK_AFTER_MS = 15 * 60 * 1000; // al volver a la app, se busca una versión nueva cada 15 min

const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

let registration = null;
let updateRequested = false; // true solo cuando la persona pidió actualizar (para reiniciar la app una vez)
let lastCheck = Date.now();

/** Error con un mensaje listo para mostrarle a la persona. */
export class PwaError extends Error {}

/* =========================================================
   1. AVISO "HAY UNA VERSIÓN NUEVA"
   ========================================================= */

function setBannerVisible(visible) {
  const banner = document.getElementById('update-banner');
  if (banner) banner.hidden = !visible;
}

/** La versión nueva ya está descargada y esperando a que la actives. */
function watchRegistration(reg) {
  if (reg.waiting && navigator.serviceWorker.controller) setBannerVisible(true);

  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // Solo se avisa si ya había una versión funcionando (la primera instalación no necesita aviso)
      if (worker.state === 'installed' && navigator.serviceWorker.controller) setBannerVisible(true);
    });
  });
}

/** Activa la versión nueva que está esperando. La app se reinicia sola al terminar. */
function activate(worker) {
  updateRequested = true;
  worker.postMessage({ type: 'SKIP_WAITING' });
}

/* =========================================================
   2. COMUNICACIÓN CON EL SERVICE WORKER
   ========================================================= */

/** Le manda un mensaje al service worker y espera su respuesta (o null si tarda demasiado). */
function ask(worker, message, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.postMessage(message, [channel.port2]);
  });
}

function waitUntilInstalled(worker) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (worker.state === 'installed' || worker.state === 'activated') resolve();
      else if (worker.state === 'redundant') reject(new PwaError('La versión nueva no se pudo descargar completa. Revisa tu internet e intenta de nuevo.'));
    };
    worker.addEventListener('statechange', check);
    check();
  });
}

/* =========================================================
   3. LO QUE USAN OTROS ARCHIVOS
   ========================================================= */

/**
 * Datos para mostrar en Ajustes:
 *   supported    -> el navegador permite usar la app sin internet
 *   ready        -> el service worker ya está funcionando
 *   version      -> número de versión instalada
 *   offlineReady -> todos los archivos están guardados para abrir sin internet
 *   updateWaiting-> ya hay una versión nueva descargada esperando
 */
export async function getAppInfo() {
  if (!supported) return { supported: false, ready: false };

  const reg = registration || (await navigator.serviceWorker.getRegistration());
  const worker = navigator.serviceWorker.controller || (reg && reg.active);
  if (!worker) return { supported: true, ready: false, updateWaiting: false };

  const info = await ask(worker, { type: 'GET_INFO' });
  if (!info) return { supported: true, ready: false, updateWaiting: false };

  return {
    supported: true,
    ready: true,
    version: info.version,
    offlineReady: info.cached >= info.expected,
    updateWaiting: Boolean(reg && reg.waiting),
  };
}

/**
 * Botón "Actualizar archivos de la app". Necesita internet.
 *   1) Si ya hay una versión nueva descargada, la activa.
 *   2) Si no, busca una; si la encuentra, la descarga completa y la activa.
 *   3) Si no hay versión nueva, vuelve a descargar los archivos de la versión actual
 *      (arregla una copia dañada o una subida a GitHub sin cambiar el número de versión).
 * Siempre se descarga TODO antes de reemplazar algo. Devuelve 'updating' o 'refreshed'.
 */
export async function updateApp() {
  if (!supported || !registration) {
    throw new PwaError('Este navegador no permite usar la app sin internet ni actualizarla.');
  }

  // 1) Ya hay una versión nueva esperando
  if (registration.waiting) {
    activate(registration.waiting);
    return 'updating';
  }

  // 2) Buscar una versión nueva
  try {
    await registration.update();
  } catch {
    throw new PwaError('No se pudo buscar la actualización. Necesitas internet para actualizar.');
  }

  const incoming = registration.installing || registration.waiting;
  if (incoming) {
    await waitUntilInstalled(incoming);
    activate(registration.waiting || incoming);
    return 'updating';
  }

  // 3) Misma versión: se vuelven a descargar los archivos
  const active = registration.active;
  if (!active) throw new PwaError('La app todavía se está preparando. Intenta de nuevo en un momento.');

  const result = await ask(active, { type: 'REFRESH_CACHE' }, 60 * 1000);
  if (!result || !result.ok) {
    throw new PwaError('No se pudieron descargar los archivos. Revisa tu internet e intenta de nuevo.');
  }
  return 'refreshed';
}

/* =========================================================
   4. ARRANQUE
   ========================================================= */

export async function initPwa() {
  if (!supported) return;

  // Cuando la versión nueva toma el control, se reinicia la app UNA vez (solo si la persona lo pidió)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) window.location.reload();
  });

  const updateButton = document.getElementById('update-banner-button');
  if (updateButton) {
    updateButton.addEventListener('click', () => {
      updateButton.disabled = true;
      if (registration && registration.waiting) activate(registration.waiting);
      else window.location.reload();
    });
  }

  try {
    registration = await navigator.serviceWorker.register(SW_URL, { updateViaCache: 'none' });
  } catch (error) {
    console.error('No se pudo activar el modo sin internet:', error);
    return;
  }
  watchRegistration(registration);

  // Si dejas la app abierta mucho tiempo, al volver a ella se busca una versión nueva
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !registration) return;
    if (Date.now() - lastCheck < RECHECK_AFTER_MS) return;
    lastCheck = Date.now();
    registration.update().catch(() => {
      /* sin internet: se intentará más tarde */
    });
  });
}
