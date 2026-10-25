import Live from './live.js';
window.TMLive = Live;
Live.restore()
  .then((w) => (w ? Live.whenReady() : null))
  .catch(() => null)
  .finally(() => { if (window.liveMark) window.liveMark(); window.dispatchEvent(new Event('tmlive')); });
