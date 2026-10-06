/*
 * No-flash theme bootstrap.
 *
 * Classic same-origin script: it runs before the first paint, so the stored
 * theme choice applies without a flash — and it keeps `script-src 'self'` free
 * of 'unsafe-inline'. No stored choice means "follow the system": the
 * media query drives both native color-scheme and Kumo's data-mode selector.
 */
(() => {
  let stored = null;
  try {
    stored = window.localStorage.getItem('pdf-editor.theme');
  } catch {
    // Storage may be blocked; the system preference still works.
  }
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const mode = stored === 'light' || stored === 'dark' ? stored : system.matches ? 'dark' : 'light';
    document.documentElement.style.colorScheme = mode;
    document.documentElement.dataset.mode = mode;
  };
  apply();
  system.addEventListener('change', apply);
})();
