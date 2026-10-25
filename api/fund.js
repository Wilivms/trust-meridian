// Welcome top-up: a new wallet receives test USDC from the treasury so it can
// join a Circle, add an expense or pay a bill right away.
import { Keypair } from '@stellar/stellar-sdk';
import { CFG, invokeFn, simulate, signEntries, relay, b64, sv, json } from './_lib.js';

const AMOUNT = 100n * 10_000_000n;
const given = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const to = String(body.to || '');
    if (!/^C[A-Z2-7]{55}$/.test(to)) return json(res, 400, { error: 'Smart wallet address expected' });
    if (given.has(to)) return json(res, 200, { already: true });
    const t = Keypair.fromSecret(process.env.TREASURY_SECRET);
    const func = invokeFn(CFG.usdc, 'transfer', [sv.addr(t.publicKey()), sv.addr(to), sv.i128(AMOUNT)]);
    const s = await simulate(func);
    const auth = await signEntries(s.auth, [t]);
    const r = await relay({ func: b64(func), auth: auth.map(b64) });
    if (r.success) given.set(to, r.hash);
    return json(res, 200, { ...r, amount: 100 });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
}
