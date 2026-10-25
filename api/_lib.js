// Shared server helpers for the Vercel functions.
import {
  Address, Asset, Horizon, Keypair, Operation, TransactionBuilder, authorizeEntry, nativeToScVal, rpc, scValToNative, xdr, Account,
} from '@stellar/stellar-sdk';

const env = process.env;
export const CFG = {
  rpcUrl: env.RPC_URL || env.VITE_RPC_URL || 'https://soroban-testnet.stellar.org',
  passphrase: env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  circle: env.VITE_CIRCLE_ID,
  settle: env.VITE_SETTLE_ID,
  claim: env.VITE_CLAIM_ID,
  usdc: env.VITE_USDC_ID,
};
export const server = new rpc.Server(CFG.rpcUrl);

/** Family members played by the server in the demo (testnet keys only). */
export function bots() {
  const raw = env.BOT_SECRETS ? JSON.parse(env.BOT_SECRETS) : {};
  const out = {};
  for (const [name, secret] of Object.entries(raw)) out[name] = Keypair.fromSecret(secret);
  return out;
}

/** Fee sponsors: funded testnet accounts that pay every fee (users never hold XLM). */
function sponsors() {
  const raw = env.SPONSOR_SECRETS ? JSON.parse(env.SPONSOR_SECRETS) : [];
  return raw.map((s) => Keypair.fromSecret(s));
}

async function waitFor(hash) {
  for (let i = 0; i < 60; i++) {
    const g = await server.getTransaction(hash);
    if (g.status === 'SUCCESS') return { ok: true, ledger: g.ledger, result: g.returnValue ? scValToNative(g.returnValue) : null };
    if (g.status === 'FAILED') return { ok: false, ledger: g.ledger };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, timeout: true };
}

/**
 * Submits { func, auth } with a sponsor as the transaction source.
 * Simulates with the given (signed) auth, adds a resource margin, and wraps
 * the transaction in a fee bump when the testnet resource fee exceeds 32 bits.
 */
export async function relay(body) {
  if (body.xdr) {
    const tx = TransactionBuilder.fromXDR(body.xdr, CFG.passphrase);
    const s = await server.sendTransaction(tx);
    if (s.status === 'ERROR') throw new Error('rejected');
    const w = await waitFor(s.hash);
    return { success: w.ok, hash: s.hash, status: w.ok ? 'SUCCESS' : 'FAILED', ledger: w.ledger };
  }
  const list = sponsors();
  if (!list.length) throw new Error('No fee sponsor configured');
  const kp = list[Math.floor(Math.random() * list.length)];
  const func = typeof body.func === 'string' ? xdr.HostFunction.fromXDR(body.func, 'base64') : body.func;
  const auth = (body.auth || []).map((a) => (typeof a === 'string' ? xdr.SorobanAuthorizationEntry.fromXDR(a, 'base64') : a));
  const acct = await server.getAccount(kp.publicKey());
  const draft = new TransactionBuilder(acct, { fee: '1000', networkPassphrase: CFG.passphrase })
    .addOperation(Operation.invokeHostFunction({ func, auth })).setTimeout(120).build();
  const sim = await server.simulateTransaction(draft);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error.split('\n')[0]);
  const finalAuth = auth.length ? auth : (sim.result ? sim.result.auth : []);
  const r0 = sim.transactionData.build().resources();
  const resFee = BigInt(sim.minResourceFee) * 120n / 100n;
  const data = sim.transactionData
    .setResources(Math.min(Math.ceil(r0.instructions() * 1.3), 600_000_000), r0.diskReadBytes(), Math.ceil(r0.writeBytes() * 1.1))
    .setResourceFee(resFee)
    .build();
  const acct2 = await server.getAccount(kp.publicKey());
  const op = Operation.invokeHostFunction({ func, auth: finalAuth });
  let envelope;
  if (resFee + 1000n < 4_000_000_000n) {
    envelope = new TransactionBuilder(acct2, { fee: String(resFee + 1000n), networkPassphrase: CFG.passphrase, sorobanData: data }).addOperation(op).setTimeout(120).build();
    envelope.sign(kp);
  } else {
    const plain = new TransactionBuilder(acct2, { fee: '1000', networkPassphrase: CFG.passphrase }).addOperation(op).setTimeout(120).build();
    const e = plain.toEnvelope(); e.v1().tx().ext(new xdr.TransactionExt(1, data));
    const inner = TransactionBuilder.fromXDR(e.toXDR('base64'), CFG.passphrase); inner.sign(kp);
    envelope = TransactionBuilder.buildFeeBumpTransaction(kp, String(resFee + 10000n), inner, CFG.passphrase); envelope.sign(kp);
  }
  const s = await server.sendTransaction(envelope);
  if (s.status === 'ERROR') throw new Error('Transaction rejected');
  const w = await waitFor(s.hash);
  if (!w.ok) return { success: false, hash: s.hash, status: 'FAILED', error: 'Transaction failed on-chain' };
  return { success: true, hash: s.hash, status: 'SUCCESS', ledger: w.ledger, result: w.result };
}

export function invokeFn(contractId, method, args) {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: new Address(contractId).toScAddress(), functionName: method, args }),
  );
}

/** Simulates a call in recording mode and returns { func, auth, result }. */
export async function simulate(func, source) {
  const acct = source ? await server.getAccount(source) : new Account(Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(acct, { fee: '1000000', networkPassphrase: CFG.passphrase })
    .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
    .setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return { func, auth: sim.result ? sim.result.auth : [], result: sim.result && sim.result.retval ? scValToNative(sim.result.retval) : null };
}

/** Signs every auth entry that belongs to one of the given keypairs. */
export async function signEntries(entries, keypairs) {
  const latest = await server.getLatestLedger();
  const until = latest.sequence + 600;
  const byAddr = Object.fromEntries(keypairs.map((k) => [k.publicKey(), k]));
  const out = [];
  for (const e of entries) {
    const entry = typeof e === 'string' ? xdr.SorobanAuthorizationEntry.fromXDR(e, 'base64') : e;
    const cred = entry.credentials();
    if (cred.switch().name === 'sorobanCredentialsAddress') {
      const a = Address.fromScAddress(cred.address().address()).toString();
      if (byAddr[a]) { out.push(await authorizeEntry(entry, byAddr[a], until, CFG.passphrase)); continue; }
    }
    out.push(entry);
  }
  return out;
}

export const b64 = (x) => (typeof x === 'string' ? x : x.toXDR('base64'));
export const sv = {
  u32: (n) => nativeToScVal(Number(n), { type: 'u32' }),
  i128: (n) => nativeToScVal(BigInt(n), { type: 'i128' }),
  addr: (a) => new Address(a).toScVal(),
  bytes: (hex) => xdr.ScVal.scvBytes(Buffer.from(hex, 'hex')),
  bool: (b) => nativeToScVal(!!b),
  str: (x) => nativeToScVal(String(x), { type: 'string' }),
};

export function json(res, code, body) {
  res.status(code).setHeader('content-type', 'application/json').send(JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** Contracts the relayer is allowed to call (plus wallet deployments). */
export function allowed(funcB64) {
  const f = xdr.HostFunction.fromXDR(funcB64, 'base64');
  const t = f.switch().name;
  if (t === 'hostFunctionTypeCreateContractV2' || t === 'hostFunctionTypeCreateContract') return true;
  if (t !== 'hostFunctionTypeInvokeContract') return false;
  const target = Address.fromScAddress(f.invokeContract().contractAddress()).toString();
  return [CFG.circle, CFG.settle, CFG.claim, CFG.usdc].includes(target) || target.startsWith('C');
}

// ---------- demo upkeep: family accounts buy test USDC on the testnet DEX when low ----------
const horizon = new Horizon.Server(env.HORIZON_URL || 'https://horizon-testnet.stellar.org');
const USDC_ASSET = new Asset('USDC', env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');

async function classic(kp, op) {
  const acct = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: '10000', networkPassphrase: CFG.passphrase }).addOperation(op).setTimeout(60).build();
  tx.sign(kp);
  return horizon.submitTransaction(tx);
}

/** Keeps a demo account above `min` USDC (buys with its own XLM; friendbot when XLM runs low). */
export async function refill(kp, min, target = min * 2) {
  let acct = await horizon.loadAccount(kp.publicKey());
  const bal = (code) => Number((acct.balances.find((b) => (code ? b.asset_code === code : b.asset_type === 'native')) || {}).balance || 0);
  let usdc = bal('USDC');
  if (usdc >= min) return { usdc, bought: 0 };
  if (bal() < (target - usdc) * 2 + 500) {
    const tmp = Keypair.random();
    await fetch(`https://friendbot.stellar.org/?addr=${tmp.publicKey()}`);
    await classic(tmp, Operation.accountMerge({ destination: kp.publicKey() }));
  }
  let left = Math.ceil(target - usdc), bought = 0;
  while (left > 0) {
    const chunk = Math.min(left, 500);
    await classic(kp, Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: String(chunk * 3), destination: kp.publicKey(), destAsset: USDC_ASSET, destAmount: String(chunk), path: [] }));
    left -= chunk; bought += chunk;
  }
  return { usdc: usdc + bought, bought };
}
