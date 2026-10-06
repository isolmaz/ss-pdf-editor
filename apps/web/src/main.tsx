import { warmPdfjs } from 'pdf-core';
import { SessionStore } from 'pdf-model';
import { loadLocale } from 'pdf-shared';
import { getStoredLocale } from 'pdf-ui/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initServiceWorkerUpdates } from './serviceWorkerUpdate';
import './app.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

// One session store for the whole app. React subscribes to it; nothing
// else owns document state.
const store = new SessionStore();

// The interface language's catalogue is a chunk of its own (`pdf-shared` i18n): it is
// fetched before the first render, so the first frame is already in that language and
// the other catalogue is never downloaded.
const render = () =>
  createRoot(container).render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  );
loadLocale(getStoredLocale()).then(render, render);

// The engine chunk is lazy for the sake of first paint; warming it while the browser is
// idle means the *first* file the user picks does not wait for the download and parse.
// It is the same same-origin chunk the open path would fetch - no new request appears
// that a cold open would not have made.
//
// The two surfaces the shell reaches through a dynamic boundary (`pdf-ui/printing`,
// `pdf-ui/palette`) are warmed the same way and for the same reason: they are lazy so
// the entry chunk stays inside the ≤250 KiB budget, and prefetching them
// on idle keeps the first `Ctrl+P` or `Ctrl+K` from being a visible wait.
const warm = () => {
  warmPdfjs();
  void import('pdf-ui/printing').catch(() => undefined);
  void import('pdf-ui/palette').catch(() => undefined);
  initServiceWorkerUpdates();
};
if ('requestIdleCallback' in window) {
  window.requestIdleCallback(warm, { timeout: 3000 });
} else {
  setTimeout(warm, 2000);
}
