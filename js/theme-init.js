/* theme-init.js
   Script mínimo que se ejecuta en cuanto carga la página, antes de dibujarla,
   para que el modo oscuro no "parpadee" en blanco al abrir la app.
   Solo LEE la elección guardada; la guarda theme.js (vía storage.js).
   La llave debe ser la misma que THEME_KEY de storage.js. */
(function () {
  try {
    var theme = localStorage.getItem('finanzas-app:theme');
    if (theme !== 'dark' && theme !== 'light') return;
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0f1420' : '#f5f7fb');
  } catch (e) {
    /* si el navegador bloquea el almacenamiento, se queda en claro */
  }
})();
