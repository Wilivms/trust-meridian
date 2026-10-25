// The bill agent. The user gives it a key on their smart account: a context rule
// limited to USDC transfers, with OpenZeppelin's spending-limit policy (a weekly
// budget). The agent (Claude) picks which recurring bills to pay now, then signs
// each payment as that delegated signer. The wallet itself enforces the budget:
// a payment over the limit is refused on-chain, whatever the agent decides.
import Anthropic from '@anthropic-ai/sdk';
import { Address, Keypair, authorizeEntry, hash, xdr } from '@stellar/stellar-sdk';
import { CFG, bots, invokeFn, json, relay, server, simulate, sv } from './_lib.js';

const MODEL = process.env.CLAUDE_FAST_MODEL || 'claude-haiku-5-5';
const NAMES = ['you', 'lea', 'hugo', 'ines', 'noah', 'emma'];
const agent = () => Keypair.fromSecret(process.env.AGENT_SECRET);

// Protocol 27 smart-account auth: digest = sha256(sha256(preimage) ‖ vec(rule ids))
function authDigest(entry, expiration, ruleIds) {
  const c = entry.credentials().address();
  c.signatureExpirationLedger(expiration);
  const pre = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
    networkId: hash(Buffer.from(CFG.passphrase)), nonce: c.nonce(), signatureExpirationLedger: expiration, invocation: entry.rootInvocation(),
  }));
  const payload = hash(pre.toXDR());
  return hash(Buffer.concat([payload, xdr.ScVal.scvVec(ruleIds.map((i) => xdr.ScVal.scvU32(i))).toXDR()]));
}

/** One USDC payment from `wallet`, signed by the agent under context rule `ruleId`. */
async function agentPay(wallet, ruleId, to, usd) {
  const kp = agent();
  const units = BigInt(Math.round(usd * 1e7));
  const func = invokeFn(CFG.usdc, 'transfer', [sv.addr(wallet), sv.addr(to), sv.i128(units)]);
  const s = await simulate(func);
  const entry = s.auth.find((e) => e.credentials().switch().name === 'sorobanCredentialsAddress'
    && Address.fromScAddress(e.credentials().address().address()).toString() === wallet);
  if (!entry) throw new Error('No wallet authorization to sign');
  const latest = await server.getLatestLedger();
  const exp = latest.sequence + 120;
  const digest = authDigest(entry, exp, [ruleId]);
  // AuthPayload: the rule, and the delegated signer with empty bytes (its proof is the nested entry)
  const signerKey = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Delegated'), xdr.ScVal.scvAddress(new Address(kp.publicKey()).toScAddress())]);
  entry.credentials().address().signature(xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('context_rule_ids'), val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(ruleId)]) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('signers'), val: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: signerKey, val: xdr.ScVal.scvBytes(Buffer.alloc(0)) })]) }),
  ]));
  // the delegated signer authorizes __check_auth(digest) on the wallet
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
      contractAddress: new Address(wallet).toScAddress(), functionName: '__check_auth', args: [xdr.ScVal.scvBytes(digest)],
    })),
    subInvocations: [],
  });
  const nested = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
      address: new Address(kp.publicKey()).toScAddress(), nonce: xdr.Int64.fromString(String(BigInt.asIntN(64, BigInt(Math.floor(Math.random() * 2 ** 53)) * 1024n + BigInt(Date.now() % 1024)))),
      signatureExpirationLedger: exp, signature: xdr.ScVal.scvVoid(),
    })),
    rootInvocation: invocation,
  });
  const signedNested = await authorizeEntry(nested, kp, exp, CFG.passphrase);
  const r = await relay({ func: func.toXDR('base64'), auth: [entry.toXDR('base64'), signedNested.toXDR('base64')] });
  if (!r.success) throw new Error('Payment failed');
  return r;
}

// Claude picks the bills to pay now, within what is left of the week's budget
async function plan(bills, budgetLeft) {
  const fallback = () => { let left = budgetLeft; return bills.filter((b) => b.due <= 3 && (left -= b.usdc) >= 0).map((b) => b.id); };
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: MODEL, max_tokens: 300,
      system: 'You are a family bill-paying agent. Pay only bills due within 3 days, never exceed the remaining weekly budget, and prefer the most urgent. Reply with JSON only: {"pay": [ids], "note": one short sentence for the family}.',
      messages: [{ role: 'user', content: JSON.stringify({ budgetLeftUSDC: budgetLeft, bills }) }],
    });
    const m = /\{[\s\S]*\}/.exec(msg.content.map((c) => c.text || '').join(''));
    const j = m ? JSON.parse(m[0]) : null;
    if (j && Array.isArray(j.pay)) return { ids: j.pay.map(String), note: j.note || '', by: MODEL };
  } catch (e) { /* the rule below */ }
  return { ids: fallback(), note: 'Paid the bills due within three days, within the weekly budget.', by: 'rule' };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return json(res, 200, { agent: agent().publicKey(), policy: process.env.VITE_SPENDING_LIMIT_POLICY_ADDRESS });
    if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const wallet = String(b.wallet || ''), ruleId = Number(b.ruleId);
    if (!/^C[A-Z2-7]{55}$/.test(wallet) || !Number.isInteger(ruleId)) return json(res, 400, { error: 'wallet and ruleId required' });
    const B = bots(), payeeOf = (i) => B[NAMES[Number(i)]]?.publicKey();
    if (b.action === 'pay') {
      // a single payment, used to show that the wallet refuses one over the limit
      try { const r = await agentPay(wallet, ruleId, payeeOf(b.payee), Number(b.usdc)); return json(res, 200, { ok: true, hash: r.hash }); }
      catch (e) { return json(res, 200, { ok: false, refused: true, error: String(e.message || e).slice(0, 200) }); }
    }
    if (b.action === 'run') {
      const bills = (b.bills || []).slice(0, 8).map((x) => ({ id: String(x.id), title: String(x.title).slice(0, 60), payee: x.payee, usdc: Number(x.usdc), due: Number(x.due) }));
      const p = await plan(bills, Number(b.budgetLeft) || 0);
      const results = [];
      for (const id of p.ids) {
        const bill = bills.find((x) => x.id === id); if (!bill) continue;
        try { const r = await agentPay(wallet, ruleId, payeeOf(bill.payee), bill.usdc); results.push({ id, ok: true, hash: r.hash }); }
        catch (e) { results.push({ id, ok: false, error: String(e.message || e).slice(0, 160) }); }
      }
      return json(res, 200, { note: p.note, by: p.by, results });
    }
    return json(res, 400, { error: 'Unknown action' });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
}
