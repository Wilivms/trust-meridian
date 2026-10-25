// Sets up a new wallet's family on testnet, one step per call (each step is
// one or a few transactions, signed by the family members the server plays).
//   fund   – 1,000 test USDC from the treasury
//   c1     – "Lopes Family" circle (100 USDC/month, 6 members, Hugo's turn)
//   c2     – "Paris–Lagos savers" (200 USDC, deposits on XOXNO), Léa and Noah paid
//   s1     – "Lisbon weekend" Settle group, with the family's expenses
// FAM index → member: 0 you, 1 lea, 2 hugo, 3 ines, 4 noah, 5 emma
import { Keypair, xdr } from '@stellar/stellar-sdk';
import { CFG, bots, invokeFn, simulate, signEntries, relay, b64, sv, json, server, refill } from './_lib.js';

const U = (x) => BigInt(Math.round(Number(x) * 1e7));
const NAMES = ['you', 'lea', 'hugo', 'ines', 'noah', 'emma'];

async function act(B, who, contract, method, args) {
  const func = invokeFn(contract, method, args);
  const s = await simulate(func);
  const auth = await signEntries(s.auth, [B[who]]);
  const r = await relay({ func: b64(func), auth: auth.map(b64) });
  if (!r.success) throw new Error(`${method} by ${who} failed`);
  return r;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const me = String(body.wallet || '');
    if (!/^C[A-Z2-7]{55}$/.test(me)) return json(res, 400, { error: 'Smart wallet address expected' });
    const B = bots();
    const A = (i) => (i === 0 ? me : B[NAMES[i]].publicKey());
    const vec = (xs) => xdr.ScVal.scvVec(xs);
    const txs = [];
    switch (body.step) {
      case 'fund': {
        const t = Keypair.fromSecret(process.env.TREASURY_SECRET);
        // keep the demo family solvent: every new wallet costs them ~1,000 test USDC
        await Promise.all([refill(t, 1500, 4000), refill(B.lea, 500), refill(B.noah, 500), refill(B.hugo, 200), refill(B.ines, 200), refill(B.emma, 200)]);
        const func = invokeFn(CFG.usdc, 'transfer', [sv.addr(t.publicKey()), sv.addr(me), sv.i128(U(1000))]);
        const s = await simulate(func);
        const r = await relay({ func: b64(func), auth: (await signEntries(s.auth, [t])).map(b64) });
        return json(res, 200, { hashes: [r.hash] });
      }
      case 'c1': {
        const order = [2, 3, 4, 5, 0, 1];
        const r = await act(B, 'hugo', CFG.circle, 'create', [sv.addr(A(2)), sv.str('Lopes Family'), sv.i128(U(100)), sv.i128(0n), vec(order.map((i) => sv.addr(A(i)))), sv.u32(6), sv.bool(false)]);
        return json(res, 200, { id: Number(r.result), hashes: [r.hash] });
      }
      case 'c2': {
        const r = await act(B, 'lea', CFG.circle, 'create', [sv.addr(A(1)), sv.str('Paris–Lagos savers'), sv.i128(U(200)), sv.i128(U(20)), vec([0, 1, 4].map((i) => sv.addr(A(i)))), sv.u32(3), sv.bool(false)]);
        const id = Number(r.result); txs.push(r.hash);
        txs.push((await act(B, 'noah', CFG.circle, 'join', [sv.u32(id), sv.addr(A(4))])).hash);
        txs.push((await act(B, 'lea', CFG.circle, 'pay', [sv.u32(id), sv.addr(A(1))])).hash);
        txs.push((await act(B, 'noah', CFG.circle, 'pay', [sv.u32(id), sv.addr(A(4))])).hash);
        return json(res, 200, { id, hashes: txs });
      }
      case 's1': {
        const all = [0, 1, 2, 3, 4, 5];
        const r = await act(B, 'lea', CFG.settle, 'create_group', [sv.addr(A(1)), sv.str('Lisbon weekend'), vec(all.map((i) => sv.addr(A(i)))), sv.bool(false)]);
        const id = Number(r.result); txs.push(r.hash);
        const latest = await server.getLatestLedger();
        // Family members pre-approve a capped allowance so a half-group vote can settle.
        for (const i of [1, 2, 3, 4, 5]) txs.push((await act(B, NAMES[i], CFG.usdc, 'approve', [sv.addr(A(i)), sv.addr(CFG.settle), sv.i128(U(400)), sv.u32(latest.sequence + 150_000)])).hash);
        return json(res, 200, { id, hashes: txs });
      }
      case 's1x': {
        // the family's expenses already in the group (USDC at the Reflector rate)
        const SEED = [
          [1, 690 / 0.862, [0, 1, 2, 3, 4, 5], 'Hotel in Alfama, 4 nights'],
          [3, 640 / 1.532, [0, 1, 2, 3, 4, 5], 'Villa in Sintra, 2 nights'],
          [2, 31500 / 148.4, [0, 1, 2, 3, 4, 5], 'Dinner in Bairro Alto'],
          [1, 420 / 3.5, [0, 1, 2, 3], 'Boat trip on the Tagus'],
          [4, 154000 / 1540, [0, 1, 2, 3, 4, 5], 'Concert tickets'],
          [5, 480 / 5.4, [0, 3, 4, 5], 'Groceries at the market'],
        ];
        for (const [p, usd, parts, memo] of SEED) {
          txs.push((await act(B, NAMES[p], CFG.settle, 'add_expense', [sv.u32(body.group), sv.addr(A(p)), sv.i128(U(usd.toFixed(6))), vec(parts.map((i) => sv.addr(A(i)))), sv.str(memo)])).hash);
        }
        return json(res, 200, { hashes: txs });
      }
      case 'expense': {
        // a family member's expense, in USDC at the Reflector rate
        const e = body.expense;
        if (!e || e.payer === 0) return json(res, 400, { error: 'Family expense expected' });
        const r = await act(B, NAMES[e.payer], CFG.settle, 'add_expense', [sv.u32(body.group), sv.addr(A(e.payer)), sv.i128(U(e.usd)), vec(e.parts.map((i) => sv.addr(A(i)))), sv.str(String(e.memo).slice(0, 60))]);
        return json(res, 200, { hashes: [r.hash] });
      }
      default:
        return json(res, 400, { error: 'Unknown step' });
    }
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e).split('\n')[0] });
  }
}
