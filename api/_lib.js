// Shared server helpers for the Vercel functions.
import {
  Address, Keypair, Operation, TransactionBuilder, authorizeEntry, nativeToScVal, rpc, scValToNative, xdr, Account,
} from '@stellar/stellar-sdk';
import { ChannelsClient } from '@openzeppelin/relayer-plugin-channels';

const env = process.env;
export const CFG = {
  rpcUrl: env.RPC_URL || env.VITE_RPC_URL || 'https://soroban-testnet.stellar.org',
  passphrase: env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  relayerBase: env.RELAYER_BASE_URL || 'https://channels.openzeppelin.com/testnet',
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

let apiKey = env.OZ_CHANNELS_API_KEY || null;
async function channels() {
  if (!apiKey) {
    const r = await fetch(`${CFG.relayerBase}/gen`);
    const j = await r.json();
    apiKey = j.apiKey || j.api_key || j.key || j.token;
  }
  return new ChannelsClient({ baseUrl: CFG.relayerBase, apiKey });
}

/** Submits { func, auth } through OpenZeppelin Relayer Channels (fees sponsored). */
export async function relay(body) {
  const c = await channels();
  if (body.xdr) return c.submitTransaction({ xdr: body.xdr });
  return c.submitSorobanTransaction({ func: body.func, auth: body.auth || [] });
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
