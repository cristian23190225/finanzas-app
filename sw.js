/* =========================================================
   sw.js  (service worker)
   Hace que la app abra SIN internet: guarda una copia de sus propios
   archivos (código, estilos, librerías e íconos) en el teléfono.
   Tus DATOS (movimientos, deudas, préstamos) NO viven aquí: se guardan
   en otro lugar y esta copia nunca los toca.

   ┌─────────────────────────────────────────────────────────┐
   │  REGLA IMPORTANTE: cada vez que subas cambios a GitHub,   │
   │  sube también este archivo con el número VERSION más      │
   │  alto (1 -> 2 -> 3...). Así los teléfonos se dan cuenta   │
   │  de que hay una versión nueva y muestran el aviso         │
   │  "Hay una versión nueva. [Actualizar]".                   │
   └─────────────────────────────────────────────────────────┘

   Si agregas un archivo nuevo a la app (por ejemplo js/algo.js),
   agrégalo también a la lista FILES de abajo.
   ========================================================= */

const VERSION = 5;

const CACHE_PREFIX = 'finanzas-app-';
const CACHE_NAME = `${CACHE_PREFIX}v${VERSION}`;

// Todo lo que la app necesita para abrir sin internet (rutas desde la carpeta de la app)
const FILES = [
  './',
  'index.html',
  'manifest.json',
  'css/styles.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/main.js',
  'js/theme-init.js',
  'js/calendar.js',
  'js/debts.js',
  'js/loans.js',
  'js/summary.js',
  'js/export.js',
  'js/storage.js',
  'js/transactions.js',
  'js/ui.js',
  'js/utils.js',
  'js/theme.js',
  'js/settings.js',
  'js/backup.js',
  'js/libs.js',
  'js/pwa.js',
  'js/home.js',
  'lib/jspdf.umd.min.js',
  'lib/jspdf.plugin.autotable.min.js',
  'lib/xlsx-writer.min.js',
  'lib/backup-tools.min.js',
];

// Direcciones completas (el service worker las calcula desde donde vive este archivo)
const URLS = FILES.map((file) => new URL(file, self.registration.scope).href);
const INDEX_URL = new URL('index.html', self.registration.scope).href;

/* =========================================================
   1. DESCARGA DE ARCHIVOS
   ========================================================= */

/**
 * Descarga TODOS los archivos de la app (siempre frescos, sin usar copias viejas
 * del navegador). Si falta uno solo, falla: así nunca queda una copia a medias.
 * Devuelve la lista de [dirección, respuesta].
 */
async function downloadAll() {
  const entries = await Promise.all(
    URLS.map(async (url) => {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok) throw new Error(`${url} respondió ${response.status}`);
      return [url, response];
    })
  );
  return entries;
}

/** Guarda en el caché lo ya descargado (todo junto, hasta que ya está completo). */
async function storeAll(cacheName, entries) {
  const cache = await caches.open(cacheName);
  await Promise.all(entries.map(([url, response]) => cache.put(url, response)));
}

/* =========================================================
   2. INSTALAR: se guarda la copia de esta versión.
   NO se activa sola: la versión vieja sigue funcionando hasta que
   la persona toque "Actualizar" (o cierre y vuelva a abrir la app).
   ========================================================= */

self.addEventListener('install', (event) => {
  event.waitUntil(downloadAll().then((entries) => storeAll(CACHE_NAME, entries)));
});

/* =========================================================
   3. ACTIVAR: se borran las copias de versiones anteriores
   ========================================================= */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/* =========================================================
   4. RESPONDER A LA APP: primero la copia guardada, y si no hay, internet
   ========================================================= */

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      let saved = await cache.match(request, { ignoreSearch: true });
      // Abrir la app (cualquier dirección de la carpeta) siempre entrega index.html
      if (!saved && request.mode === 'navigate') saved = await cache.match(INDEX_URL);
      if (saved) return saved;

      try {
        return await fetch(request);
      } catch {
        return new Response('Sin conexión', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })()
  );
});

/* =========================================================
   5. MENSAJES DE LA APP
      SKIP_WAITING  -> activar la versión nueva ahora
      GET_INFO      -> versión y cuántos archivos hay guardados
      REFRESH_CACHE -> volver a descargar los archivos de esta versión
   ========================================================= */

async function getInfo() {
  const cache = await caches.open(CACHE_NAME);
  const saved = await cache.keys();
  return { version: VERSION, cached: saved.length, expected: URLS.length };
}

/**
 * Vuelve a descargar todos los archivos. Primero baja TODO; solo si todo
 * llegó bien reemplaza lo guardado. Si algo falla (por ejemplo, se va el
 * internet), la copia que ya funcionaba se queda exactamente igual.
 */
async function refreshAll() {
  try {
    const entries = await downloadAll();
    await storeAll(CACHE_NAME, entries);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  const reply = (result) => {
    if (port) port.postMessage(result);
  };

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'GET_INFO') {
    event.waitUntil(getInfo().then(reply, () => reply(null)));
  } else if (data.type === 'REFRESH_CACHE') {
    event.waitUntil(refreshAll().then(reply));
  }
});
