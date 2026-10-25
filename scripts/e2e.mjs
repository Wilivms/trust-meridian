// End-to-end check on testnet with the demo family (server-held testnet keys).
import fs from 'node:fs';
import { Keypair, Address, xdr } from '@stellar/stellar-sdk';
import { key, invoke, read, sv, server } from './stellar.mjs';
const D = JSON.parse(fs.readFileSync('deployments/testnet.json'));
const [lea, noah, emma, treasury] = ['lea', 'noah', 'emma', 'treasury'].map(key);
const U = (x) => BigInt(Math.round(x * 1e7));
const log = (k, r) => console.log(k.padEnd(28), r.hash, r.ret !== null && r.ret !== undefined ? JSON.stringify(r.ret, (a, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 120) : '');
const step = process.argv[2] || 'all';
const START = process.argv[3];
const vec = (xs) => xdr.ScVal.scvVec(xs);

if (step === 'all' || step === 'circle') {
  let id;
  if (START) id = Number(START); else { const r = await invoke(lea, D.circle, 'create', [sv.addr(lea.publicKey()), sv.str('Paris–Lagos savers'), sv.i128(U(10)), sv.i128(U(20)), vec([sv.addr(noah.publicKey()), sv.addr(emma.publicKey())]), sv.u32(5), sv.bool(false)]); log('circle.create (+XOXNO deposit)', r); id = r.ret; }
  log('circle.join noah', await invoke(noah, D.circle, 'join', [sv.u32(id), sv.addr(noah.publicKey())]));
  log('circle.join emma', await invoke(emma, D.circle, 'join', [sv.u32(id), sv.addr(emma.publicKey())]));
  log('circle.advance emma (XOXNO)', await invoke(emma, D.circle, 'advance', [sv.u32(id), sv.addr(emma.publicKey()), sv.i128(U(5))]));
  for (const k of [lea, noah, emma]) log('circle.pay', await invoke(k, D.circle, 'pay', [sv.u32(id), sv.addr(k.publicKey())]));
  log('circle.payout lea+noah', await invoke(lea, D.circle, 'payout', [sv.u32(id), sv.addr(lea.publicKey()), sv.addr(noah.publicKey())], [noah]));
  const c = await read(D.circle, 'get_circle', [sv.u32(id)]);
  console.log('circle state', JSON.stringify({ round: c.round, account: c.account?.toString(), deposits: c.deposits.map(String), advances: c.advances.map(String) }));
  fs.writeFileSync('.secrets/e2e-circle', String(id));
}
if (step === 'all' || step === 'park') {
  const r = await invoke(lea, D.circle, 'create', [sv.addr(lea.publicKey()), sv.str('Weekend fund'), sv.i128(U(10)), sv.i128(0), vec([sv.addr(noah.publicKey()), sv.addr(emma.publicKey())]), sv.u32(5), sv.bool(false)]);
  log('circle.create', r); const id = r.ret;
  for (const k of [lea, noah, emma]) log('circle.pay', await invoke(k, D.circle, 'pay', [sv.u32(id), sv.addr(k.publicKey())]));
  log('circle.park → DeFindex → XOXNO', await invoke(lea, D.circle, 'park', [sv.u32(id), sv.addr(lea.publicKey())]));
  log('circle.payout (unpark)', await invoke(lea, D.circle, 'payout', [sv.u32(id), sv.addr(lea.publicKey()), sv.addr(noah.publicKey())], [noah]));
}
if (step === 'all' || step === 'settle') {
  const r = await invoke(lea, D.settle, 'create_group', [sv.addr(lea.publicKey()), sv.str('Lisbon weekend'), vec([sv.addr(noah.publicKey()), sv.addr(emma.publicKey())]), sv.bool(false)]);
  log('settle.create_group', r); const g = r.ret;
  const all = vec([lea, noah, emma].map((k) => sv.addr(k.publicKey())));
  log('settle.add_expense lea 30', await invoke(lea, D.settle, 'add_expense', [sv.u32(g), sv.addr(lea.publicKey()), sv.i128(U(30)), all, sv.str('Fado night in Alfama')]));
  const latest = await server.getLatestLedger();
  for (const k of [noah, emma]) log('usdc.approve → settle', await invoke(k, D.usdc, 'approve', [sv.addr(k.publicKey()), sv.addr(D.settle), sv.i128(U(10)), sv.u32(latest.sequence + 100000)]));
  log('settle.approve noah', await invoke(noah, D.settle, 'approve', [sv.u32(g), sv.addr(noah.publicKey())]));
  log('settle.approve emma (settles)', await invoke(emma, D.settle, 'approve', [sv.u32(g), sv.addr(emma.publicKey())]));
}
if (step === 'all' || step === 'claim') {
  const link = Keypair.random();
  const r = await invoke(lea, D.claim, 'create', [sv.addr(lea.publicKey()), sv.i128(U(3)), xdr.ScVal.scvBytes(link.rawPublicKey()), sv.u32(0)]);
  log('claim.create', r); const id = r.ret;
  const idb = Buffer.alloc(4); idb.writeUInt32BE(id);
  const msg = Buffer.concat([Buffer.from('TM-CLAIM'), idb, new Address(noah.publicKey()).toScVal().toXDR()]);
  log('claim.claim → noah (by relayer)', await invoke(treasury, D.claim, 'claim', [sv.u32(id), sv.addr(noah.publicKey()), xdr.ScVal.scvBytes(link.sign(msg))]));
}
