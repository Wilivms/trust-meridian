import * as chain from './chain/index.js';
window.TMChain = chain;
window.dispatchEvent(new Event('tmchain'));
