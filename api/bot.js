// The other family members in the demo are played by the server (testnet keys).
// - claim:   submit a claim-link redemption (no auth needed, signature binds it)
// - pay:     a member pays this round's Circle instalment
// - approve: a member approves the Settle settlement
// - cosign:  add a member's signature to a call the user already signed
//            (e.g. a Circle payout needs two different members)
// - list:    the bots' addresses
import { CFG, bots, invokeFn, simulate, signEntries, relay, b64, sv, json } from './_lib.js';
import { xdr } from '@stellar/stellar-sdk';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const B = bots();
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const who = body.who && B[body.who];
    switch (body.action) {
      case 'list':
        return json(res, 200, Object.fromEntries(Object.entries(B).map(([n, k]) => [n, k.publicKey()])));
      case 'claim': {
        const func = invokeFn(CFG.claim, 'claim', [sv.u32(body.id), sv.addr(body.to), sv.bytes(body.sig)]);
        const s = await simulate(func);
        const r = await relay({ func: b64(func), auth: s.auth.map(b64) });
        return json(res, 200, { ...r, amount: s.result });
      }
      case 'pay':
      case 'approve': {
        if (!who) return json(res, 400, { error: 'Unknown member' });
        const func = body.action === 'pay'
          ? invokeFn(CFG.circle, 'pay', [sv.u32(body.id), sv.addr(who.publicKey())])
          : invokeFn(CFG.settle, 'approve', [sv.u32(body.id), sv.addr(who.publicKey())]);
        const s = await simulate(func);
        const auth = await signEntries(s.auth, [who]);
        const r = await relay({ func: b64(func), auth: auth.map(b64) });
        return json(res, 200, { ...r, result: s.result });
      }
      case 'relay': {
        const r = await relay({ func: body.func, auth: body.auth || [] });
        return json(res, r.success ? 200 : 500, r);
      }
      case 'cosign': {
        if (!who) return json(res, 400, { error: 'Unknown member' });
        const entries = body.auth.map((a) => xdr.SorobanAuthorizationEntry.fromXDR(a, 'base64'));
        const auth = await signEntries(entries, [who]);
        const r = await relay({ func: body.func, auth: auth.map(b64) });
        return json(res, r.success ? 200 : 500, r);
      }
      default:
        return json(res, 400, { error: 'Unknown action' });
    }
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
}
