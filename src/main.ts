import { App } from './ui/app.js';

declare global {
  interface Window {
    /** Handle for debugging and automated play-throughs. */
    gemQuest?: App;
  }
}

function boot(): void {
  window.gemQuest = new App();
  if ('serviceWorker' in navigator) {
    // Best-effort offline support; failure is not fatal.
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
