import Live from './live.js';
window.TMLive = Live;
Live.restore().catch(() => null).finally(() => window.dispatchEvent(new Event('tmlive')));
