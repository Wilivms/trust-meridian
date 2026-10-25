// Trust Meridian · chain layer
// Passkey smart account (OpenZeppelin, via smart-account-kit), contract calls to
// Circle / Settle / Claim, fee-sponsored submission through our relayer.
import {
  Address, Contract, Keypair, Operation, StrKey, contract, nativeToScVal, rpc, scValToNative, xdr,
} from '@stellar/stellar-sdk';
import { SmartAccountKit, IndexedDBStorage } from 'smart-account-kit';

const E = import.meta.env;
export const CFG = {
  rpcUrl: E.VITE_RPC_URL || 'https://soroban-testnet.stellar.org',
  passphrase: E.VITE_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  circle: E.VITE_CIRCLE_ID,
  settle: E.VITE_SETTLE_ID,
  claim: E.VITE_CLAIM_ID,
  usdc: E.VITE_USDC_ID,
  reflector: E.VITE_REFLECTOR_FX || 'CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W',
  accountWasmHash: E.VITE_ACCOUNT_WASM_HASH,
  webauthnVerifier: E.VITE_WEBAUTHN_VERIFIER_ADDRESS,
  spendingLimitPolicy: E.VITE_SPENDING_LIMIT_POLICY_ADDRESS,
  thresholdPolicy: E.VITE_THRESHOLD_POLICY_ADDRESS,
  explorer: E.VITE_EXPLORER || 'https://stellar.expert/explorer/testnet',
  live: !!(E.VITE_CIRCLE_ID && E.VITE_SETTLE_ID && E.VITE_CLAIM_ID),
};
export const DEC = 10_000_000n; // 7 decimals
export const toUnits = (x) => BigInt(Math.round(Number(x) * 1e7));
export const fromUnits = (v) => Number(v) / 1e7;

export const server = new rpc.Server(CFG.rpcUrl);

let kit = null;
export function getKit() {
  if (kit) return kit;
  kit = new SmartAccountKit({
    rpcUrl: CFG.rpcUrl,
    networkPassphrase: CFG.passphrase,
    accountWasmHash: CFG.accountWasmHash,
    webauthnVerifierAddress: CFG.webauthnVerifier,
    relayerUrl: `${location.origin}/api/relay`,
    rpName: 'Trust Meridian',
    storage: new IndexedDBStorage(),
  });
  return kit;
}

export const me = () => (kit && kit.contractId) || null;

/** Restores a stored passkey session silently. */
export async function restore() {
  if (!CFG.live) return null;
  try { await getKit().connectWallet(); } catch (e) { return null; }
  return me();
}

/** Creates the passkey wallet (one Face ID / fingerprint prompt). */
export async function createWallet(name) {
  const k = getKit();
  const r = await k.createWallet('Trust Meridian', name || 'Trust Meridian', { autoSubmit: true });
  return r.contractId;
}

export async function connect() {
  await getKit().connectWallet({ prompt: true });
  return me();
}

// ---------- ScVal helpers ----------
export const sv = {
  u32: (n) => nativeToScVal(Number(n), { type: 'u32' }),
  u64: (n) => nativeToScVal(BigInt(n), { type: 'u64' }),
  i128: (n) => nativeToScVal(BigInt(n), { type: 'i128' }),
  bool: (b) => nativeToScVal(!!b),
  str: (s) => nativeToScVal(String(s), { type: 'string' }),
  addr: (a) => new Address(a).toScVal(),
  addrs: (list) => xdr.ScVal.scvVec(list.map((a) => new Address(a).toScVal())),
  bytes: (u8) => xdr.ScVal.scvBytes(Buffer.from(u8)),
  none: () => xdr.ScVal.scvVoid(),
  // A #[contracttype] struct: a map with symbol keys sorted by name.
  struct: (obj) => xdr.ScVal.scvMap(Object.keys(obj).sort().map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: obj[k] }))),
  vec: (vals) => xdr.ScVal.scvVec(vals),
};

function hostFn(contractId, method, args) {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contractId).toScAddress(),
      functionName: method,
      args,
    }),
  );
}

async function assemble(contractId, method, args) {
  const tx = await contract.AssembledTransaction.buildWithOp(
    Operation.invokeHostFunction({ func: hostFn(contractId, method, args), auth: [] }),
    {
      contractId, method, networkPassphrase: CFG.passphrase, rpcUrl: CFG.rpcUrl, server,
      timeoutInSeconds: 60, parseResultXdr: (v) => scValToNative(v),
    },
  );
  const sim = tx.simulation;
  if (sim && rpc.Api.isSimulationError(sim)) throw new Error(decodeError(sim.error));
  return tx;
}

const ERRORS = {
  circle: ['', 'Circle not found', 'Not a member', 'Already a member', 'Circle full', 'Circle closed', 'Bad amount', 'Already paid this round', 'Not everyone has paid yet', 'Two different members must sign', 'Circle finished', 'Not admin', 'Grace period not over', 'No deposit', 'Not started', 'Pot too small', 'Advance too large', 'Advance already taken', 'Turn already received', 'Lending not configured'],
  settle: ['', 'Group not found', 'Not a member', 'Already a member', 'Group full', 'Group closed', 'Bad amount', 'Nothing to settle', 'Already approved', 'No participants'],
  claim: ['', 'Link not found', 'Link not waiting', 'Bad amount', 'Not the sender', 'Key already used'],
};
let lastTarget = 'circle';
function decodeError(msg) {
  if (/balance is not sufficient|not within the allowed range|insufficient/i.test(String(msg))) return 'Not enough USDC in this wallet';
  const m = /Error\(Contract, #(\d+)\)/.exec(String(msg));
  if (m) return (ERRORS[lastTarget] || [])[+m[1]] || `Contract error #${m[1]}`;
  return String(msg).slice(0, 240);
}

/** Reads a contract view through simulation (no signature). */
export async function view(target, method, args = []) {
  lastTarget = target;
  const tx = await assemble(CFG[target], method, args);
  return tx.result;
}

// One context rule id per authorized call in the entry; our wallets have a
// single Default rule (id 0) if the kit's lookup comes back empty.
async function ruleIds(k, entry, slow = false) {
  // Wallets created here hold one Default rule (id 0): skip the indexer lookup.
  if (slow) { try { const ids = await k.resolveConnectedContextRuleIds(entry); if (ids && ids.length) return ids; } catch (e) { /* fall back */ } }
  let n = 0;
  const walk = (inv) => { n += 1; inv.subInvocations().forEach(walk); };
  walk(entry.rootInvocation());
  return Array(n).fill(0);
}

/**
 * Calls a contract as the connected wallet. The passkey signs the wallet's
 * authorization entries; the server adds any family member's signature
 * (`cosign`) and submits with a fee sponsor, so the user never holds XLM.
 */
export async function call(target, method, args = [], { cosign } = {}) {
  lastTarget = target;
  const k = getKit();
  const tx = await assemble(CFG[target], method, args);
  const op = tx.built.operations[0];
  const mine = me();
  const auth = [];
  const entries = (op.auth && op.auth.length ? op.auth : (tx.simulationData && tx.simulationData.result && tx.simulationData.result.auth) || []);
  for (const entry of entries) {
    const c = entry.credentials();
    const isMine = c.switch().name === 'sorobanCredentialsAddress' && Address.fromScAddress(c.address().address()).toString() === mine;
    auth.push((isMine ? await k.signAuthEntry(entry, { contextRuleIds: await ruleIds(k, entry) }) : entry).toXDR('base64'));
  }
  const body = { func: op.func.toXDR('base64'), auth };
  const r = await fetch('/api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cosign ? { action: 'cosign', who: cosign, ...body } : { action: 'relay', ...body }) });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(j.error || 'Transaction failed');
  return { hash: j.hash, ledger: j.ledger, result: tx.result };
}

/** Asks the server to act for a family member (bot wallet) in the demo. */
export async function bot(action, body = {}) {
  const r = await fetch('/api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...body }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Bot failed');
  return j;
}

export const txUrl = (h) => `${CFG.explorer}/tx/${h}`;
export const contractUrl = (id) => `${CFG.explorer}/contract/${id}`;

// ---------- Token ----------
export async function usdcBalance(who = me()) {
  if (!who) return 0;
  const v = await view('usdc', 'balance', [sv.addr(who)]);
  return fromUnits(v);
}
export const approveUsdc = (spender, amount, ledgers = 120_000) =>
  (async () => {
    const latest = await server.getLatestLedger();
    return call('usdc', 'approve', [sv.addr(me()), sv.addr(spender), sv.i128(toUnits(amount)), sv.u32(latest.sequence + ledgers)]);
  })();

// ---------- Circle ----------
export const circle = {
  get: (id) => view('circle', 'get_circle', [sv.u32(id)]),
  count: () => view('circle', 'count'),
  create: (name, amount, deposit, members, max, open) =>
    call('circle', 'create', [sv.addr(me()), sv.str(name), sv.i128(toUnits(amount)), sv.i128(toUnits(deposit)), sv.addrs(members), sv.u32(max), sv.bool(open)]),
  join: (id) => call('circle', 'join', [sv.u32(id), sv.addr(me())]),
  pay: (id) => call('circle', 'pay', [sv.u32(id), sv.addr(me())]),
  park: (id) => call('circle', 'park', [sv.u32(id), sv.addr(me())]),
  advance: (id, amount) => call('circle', 'advance', [sv.u32(id), sv.addr(me()), sv.i128(toUnits(amount))]),
  payout: (id, other, otherName) => call('circle', 'payout', [sv.u32(id), sv.addr(me()), sv.addr(other)], { cosign: otherName }),
  payoutCombo: (id, other, otherName, group, debts, billTo, billAmount) =>
    call('circle', 'payout_combo', [
      sv.u32(id), sv.addr(me()), sv.addr(other), sv.u32(group),
      sv.vec(debts.map((d) => sv.struct({ amount: sv.i128(toUnits(d.amount)), to: sv.addr(d.to) }))),
      billTo ? sv.addr(billTo) : sv.none(), sv.i128(toUnits(billAmount || 0)),
    ], { cosign: otherName }),
};

// ---------- Settle ----------
export const settle = {
  get: (id) => view('settle', 'get_group', [sv.u32(id)]),
  debts: (id) => view('settle', 'debts', [sv.u32(id)]),
  create: (name, members, open) => call('settle', 'create_group', [sv.addr(me()), sv.str(name), sv.addrs(members), sv.bool(open)]),
  join: (id) => call('settle', 'join', [sv.u32(id), sv.addr(me())]),
  addExpense: (id, amount, participants, memo) =>
    call('settle', 'add_expense', [sv.u32(id), sv.addr(me()), sv.i128(toUnits(amount)), sv.addrs(participants), sv.str(memo)]),
  approve: (id) => call('settle', 'approve', [sv.u32(id), sv.addr(me())]),
  pay: (id, to, amount) => call('settle', 'pay', [sv.u32(id), sv.addr(me()), sv.addr(to), sv.i128(toUnits(amount))]),
};

// ---------- Claim links ----------
export const claim = {
  /** Creates a link: a fresh ed25519 key; its secret goes in the URL fragment. */
  async create(amount, request = 0) {
    const kp = Keypair.random();
    const pub = kp.rawPublicKey();
    const r = await call('claim', 'create', [sv.addr(me()), sv.i128(toUnits(amount)), sv.bytes(pub), sv.u32(request)]);
    r.result = Number(r.result);
    const secret = StrKey.encodeEd25519SecretSeed(kp.rawSecretKey());
    return { ...r, id: r.result, url: `${location.origin}/#claim=${r.result}.${secret}` };
  },
  get: (id) => view('claim', 'get', [sv.u32(id)]),
  mine: () => view('claim', 'links_of', [sv.addr(me())]),
  back: (id) => call('claim', 'claim_back', [sv.u32(id)]),
  /** Claims to the connected wallet: signs "TM-CLAIM" ‖ id ‖ address XDR with the link key. */
  async redeem(id, secret) {
    const kp = Keypair.fromSecret(secret);
    const idb = Buffer.alloc(4); idb.writeUInt32BE(Number(id));
    const msg = Buffer.concat([Buffer.from('TM-CLAIM'), idb, new Address(me()).toScVal().toXDR()]);
    const sig = kp.sign(msg);
    return bot('claim', { id: Number(id), to: me(), sig: sig.toString('hex') });
  },
};

// ---------- Anchor: SEP-45 sign-in for a contract wallet, then a SEP-24 deposit ----------
const ANCHOR = { home: E.VITE_ANCHOR_HOME || 'testanchor.stellar.org' };
ANCHOR.base = `https://${ANCHOR.home}`;
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
let anchorToken = null;
export const anchor = {
  home: ANCHOR.home,
  /** SEP-45: the anchor sends web_auth_verify entries; the passkey signs the wallet's one. */
  async auth() {
    if (anchorToken && anchorToken.until > Date.now()) return anchorToken.jwt;
    const r = await fetch(`${ANCHOR.base}/sep45/auth?account=${me()}&home_domain=${ANCHOR.home}`);
    const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Anchor challenge failed');
    const entries = xdr.SorobanAuthorizationEntries.fromXDR(j.authorizationEntries || j.authorization_entries, 'base64');
    const k = getKit(), out = [];
    for (const e of entries) {
      const c = e.credentials();
      const mine = c.switch().name === 'sorobanCredentialsAddress' && Address.fromScAddress(c.address().address()).toString() === me();
      out.push(mine ? await k.signAuthEntry(e, { contextRuleIds: await ruleIds(k, e) }) : e);
    }
    const b64 = xdr.SorobanAuthorizationEntries.toXDR(out).toString('base64');
    const t = await fetch(`${ANCHOR.base}/sep45/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorization_entries: b64 }) });
    const tj = await t.json(); if (!t.ok || !tj.token) throw new Error(tj.error || 'Anchor sign-in failed');
    anchorToken = { jwt: tj.token, until: Date.now() + 20 * 60e3 };
    return tj.token;
  },
  /** SEP-24 interactive deposit: returns the anchor's page to open, and the transaction id. */
  async deposit(amount) {
    const jwt = await anchor.auth();
    const r = await fetch(`${ANCHOR.base}/sep24/transactions/deposit/interactive`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ asset_code: 'USDC', asset_issuer: USDC_ISSUER, account: me(), amount: String(amount), lang: 'en' }),
    });
    const j = await r.json(); if (!r.ok || !j.url) throw new Error(j.error || 'Deposit refused by the anchor');
    return j;
  },
  async status(id) {
    const jwt = await anchor.auth();
    const r = await fetch(`${ANCHOR.base}/sep24/transaction?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${jwt}` } });
    const j = await r.json(); return j.transaction || j;
  },
};

export { scValToNative, Contract, assemble };
