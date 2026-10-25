import fs from 'node:fs';
import { TransactionBuilder, Operation, xdr } from '@stellar/stellar-sdk';
import { key, server, PASS, sv, invokeOp } from './stellar.mjs';
const D = JSON.parse(fs.readFileSync('deployments/testnet.json'));
const [lea, noah, emma] = ['lea', 'noah', 'emma'].map(key);
const U = (x) => BigInt(Math.round(x * 1e7));
async function cost(label, kp, id, m, args) {
  const tx = new TransactionBuilder(await server.getAccount(kp.publicKey()), { fee: '100', networkPassphrase: PASS }).addOperation(invokeOp(id, m, args)).setTimeout(60).build();
  const s = await server.simulateTransaction(tx);
  console.log(label.padEnd(36), s.error ? 'ERR ' + s.error.slice(0, 160) : (Number(s.minResourceFee) / 1e7).toFixed(2) + ' XLM');
}
const vec = (xs) => xdr.ScVal.scvVec(xs);
await cost('settle.create_group', lea, D.settle, 'create_group', [sv.addr(lea.publicKey()), sv.str('g'), vec([sv.addr(noah.publicKey())]), sv.bool(false)]);
await cost('circle.create no deposit', lea, D.circle, 'create', [sv.addr(lea.publicKey()), sv.str('c'), sv.i128(U(10)), sv.i128(0), vec([sv.addr(noah.publicKey())]), sv.u32(5), sv.bool(false)]);
await cost('circle.create + XOXNO deposit', lea, D.circle, 'create', [sv.addr(lea.publicKey()), sv.str('c'), sv.i128(U(10)), sv.i128(U(20)), vec([sv.addr(noah.publicKey())]), sv.u32(5), sv.bool(false)]);
await cost('usdc.transfer to existing holder', lea, D.usdc, 'transfer', [sv.addr(lea.publicKey()), sv.addr(noah.publicKey()), sv.i128(U(1))]);
