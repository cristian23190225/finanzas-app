/* =========================================================
   libs.js
   Carga los archivos de la carpeta lib/ SOLO cuando hacen falta
   (al exportar o al restaurar), no al abrir la app.
   ========================================================= */

const loaded = new Map();

/** Carga un archivo de lib/ una sola vez. La ruta se calcula desde este archivo (js/ -> lib/). */
export function loadLib(fileName) {
  if (!loaded.has(fileName)) {
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL(`../lib/${fileName}`, import.meta.url).href;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`No se pudo cargar lib/${fileName}`));
      document.head.appendChild(script);
    });
    // Si falla, se permite intentarlo otra vez
    promise.catch(() => loaded.delete(fileName));
    loaded.set(fileName, promise);
  }
  return loaded.get(fileName);
}
