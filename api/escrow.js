// Cover · Trustless Work escrow (V1, single-release, testnet).
//   create  – deploys an escrow for a bill: the payee is the service provider and
//             receiver; Trust Meridian's treasury approves and releases.
//   release – the payee marks the bill delivered, the treasury approves and
//             releases: the escrow pays the payee.
// The family member funds the escrow from their passkey wallet with a plain USDC
// transfer to the escrow contract (or inside a Circle payout_combo).
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { CFG, bots, json } from './_lib.js';

const BASE = process.env.TW_API_URL || 'https://dev.api.trustlesswork.com';
const USDC_ISSUER = process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const NAMES = ['you', 'lea', 'hugo', 'ines', 'noah', 'emma'];

async function tw(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.TRUSTLESS_WORK_API_KEY },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Trustless Work ${path}: ${j.message || j.error || r.status}`);
  return j;
}

/** Builds with Trustless Work, signs with our key, submits through their helper. */
async function run(path, body, kp) {
  const { unsignedTransaction } = await tw(path, body);
  const tx = TransactionBuilder.fromXDR(unsignedTransaction, CFG.passphrase);
  tx.sign(kp);
  const sent = await tw('/helper/send-transaction', { signedXdr: tx.toXDR() });
  if (sent.status && !/SUCCESS/i.test(sent.status)) throw new Error(`Trustless Work ${path}: ${sent.message || sent.status}`);
  return { ...sent, hash: sent.hash || tx.hash().toString('hex') };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET);
    const B = bots();
    const payee = B[NAMES[Number(b.payee)]] || B.emma;
    if (b.action === 'create') {
      const amount = Math.round(Number(b.amount) * 100) / 100;
      if (!(amount > 0)) return json(res, 400, { error: 'amount required' });
      const r = await run('/deployer/single-release', {
        signer: treasury.publicKey(),
        engagementId: String(b.engagementId || `tm-${Date.now()}`).slice(0, 60),
        title: String(b.title || 'Family bill').slice(0, 60),
        description: String(b.description || 'Bill paid through Trust Meridian Cover').slice(0, 200),
        roles: {
          approver: treasury.publicKey(), serviceProvider: payee.publicKey(), platformAddress: treasury.publicKey(),
          releaseSigner: treasury.publicKey(), disputeResolver: treasury.publicKey(), receiver: payee.publicKey(),
        },
        amount,
        platformFee: 0,
        milestones: [{ description: String(b.title || 'Bill paid').slice(0, 80) }],
        trustline: { address: USDC_ISSUER, symbol: 'USDC' },
      }, treasury);
      return json(res, 200, { contractId: r.contractId || (r.escrow && r.escrow.contractId), hash: r.hash, amount });
    }
    if (b.action === 'release') {
      const id = String(b.contractId || '');
      if (!/^C[A-Z2-7]{55}$/.test(id)) return json(res, 400, { error: 'contractId required' });
      const hashes = [];
      hashes.push((await run('/escrow/single-release/change-milestone-status', { contractId: id, milestoneIndex: '0', newStatus: 'Completed', newEvidence: 'Bill paid, receipt sent to the family', serviceProvider: payee.publicKey() }, payee)).hash);
      hashes.push((await run('/escrow/single-release/approve-milestone', { contractId: id, milestoneIndex: '0', approver: treasury.publicKey() }, treasury)).hash);
      const rel = await run('/escrow/single-release/release-funds', { contractId: id, releaseSigner: treasury.publicKey() }, treasury);
      hashes.push(rel.hash);
      return json(res, 200, { hash: rel.hash, hashes });
    }
    return json(res, 400, { error: 'Unknown action' });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
}
