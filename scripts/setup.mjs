// Creates and funds the testnet accounts used by the demo: the admin, a
// treasury that tops up new wallets, and the family members played by the
// server. Each gets XLM from friendbot, a USDC trustline and USDC bought on
// the testnet DEX. Keys stay in .secrets/ (gitignored).
import { Asset, Operation } from '@stellar/stellar-sdk';
import { key, fund, send } from './stellar.mjs';
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const PLAN = { admin: 50, treasury: 4000, lea: 300, hugo: 300, ines: 300, noah: 300, emma: 300 };
for (const [name, usdc] of Object.entries(PLAN)) {
  const kp = key(name);
  await fund(kp.publicKey());
  try { await send(kp, Operation.changeTrust({ asset: USDC })); } catch (e) { if (!/op_already|SUCCESS/.test(e.message)) console.log(name, 'trust', e.message.slice(0, 120)); }
  let left = usdc;
  while (left > 0) {
    const chunk = Math.min(left, 400);
    await send(kp, Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: String(chunk * 2), destination: kp.publicKey(), destAsset: USDC, destAmount: String(chunk), path: [] }));
    left -= chunk;
  }
  console.log(name, kp.publicKey(), 'ok');
}
