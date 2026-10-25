import Live from './live.js';
window.TMLive = Live;
// rates first (no wallet needed), then the stored wallet if any
const rates = () => { if (window.loadReflector) window.loadReflector(); else setTimeout(rates, 300); };
rates();
Live.restore()
  .then((w) => (w ? Live.whenReady() : null))
  .catch(() => null)
  .finally(() => { if (window.liveMark) window.liveMark(); window.dispatchEvent(new Event('tmlive')); });
