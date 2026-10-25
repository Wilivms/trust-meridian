// Tops up a testnet account with XLM by merging fresh friendbot accounts into it.
import { Keypair, Operation } from '@stellar/stellar-sdk';
import { key, fund, send } from './stellar.mjs';
const target = key(process.argv[2] || 'admin');
const n = Number(process.argv[3] || 1);
await Promise.all(Array.from({ length: n }, async () => {
  const k = Keypair.random(); await fund(k.publicKey());
  await send(k, Operation.accountMerge({ destination: target.publicKey() }));
}));
console.log('topped up', target.publicKey(), '+', n * 10000, 'XLM');
