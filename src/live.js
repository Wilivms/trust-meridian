// Trust Meridian · live mode
// Bridges the 3D world to testnet: each action the world animates is a real
// transaction. "You" is a passkey smart wallet; the rest of the family are
// testnet accounts the server plays (it signs only for them).
import * as chain from './chain/index.js';

const NAMES = ['you', 'lea', 'hugo', 'ines', 'noah', 'emma'];
const KEY = (w) => `tm.live.${w}`;
const state = { wallet: null, ids: null, setup: null };
const load = (w) => { try { return JSON.parse(localStorage.getItem(KEY(w)) || 'null'); } catch { return null; } };
const save = () => { try { localStorage.setItem(KEY(state.wallet), JSON.stringify(state.ids)); } catch {} };

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${path} failed`);
  return j;
}
const onboard = (step, extra = {}) => post('/api/onboard', { step, wallet: state.wallet, ...extra });
let botAddr = null;
async function bots() { if (!botAddr) botAddr = await post('/api/bot', { action: 'list' }); return botAddr; }
const addrOf = async (i) => (i === 0 ? state.wallet : (await bots())[NAMES[i]]);

/** Creates the family's circles and group on testnet for this wallet (once). */
async function setup(progress = () => {}) {
  if (state.ids && state.ids.done) return state.ids;
  state.ids = state.ids || {};
  const steps = [['fund', 'Welcome USDC'], ['c1', 'Lopes Family circle'], ['c2', 'Paris–Lagos savers'], ['s1', 'Lisbon weekend group'], ['s1x', 'Lisbon weekend expenses']];
  for (const [s, label] of steps) {
    if (state.ids[s] !== undefined) continue;
    progress(label);
    const r = await onboard(s, s === 's1x' ? { group: state.ids.s1 } : {});
    state.ids[s] = r.id ?? true; save();
  }
  state.ids.done = true; save();
  return state.ids;
}

const ready = () => !!(chain.CFG.live && state.wallet && state.ids && state.ids.done);
const circleId = (protoId) => (protoId === 'c2' ? state.ids.c2 : state.ids.c1);

export const Live = {
  chain,
  enabled: () => chain.CFG.live,
  ready,
  wallet: () => state.wallet,
  explorer: chain.txUrl,

  async restore() {
    if (!chain.CFG.live) return null;
    const w = await chain.restore();
    if (w) {
      state.wallet = w; state.ids = load(w);
      if (!(state.ids && state.ids.done)) state.setup = setup();
    }
    return w;
  },
  /** Passkey wallet creation (one Face ID / fingerprint), then the family setup. */
  async createWallet(name, progress) {
    const w = await chain.createWallet(name);
    state.wallet = w; state.ids = load(w);
    state.setup = setup(progress);
    return { hash: null, wallet: w };
  },
  async connect(progress) {
    const w = await chain.connect();
    state.wallet = w; state.ids = load(w);
    state.setup = setup(progress);
    return w;
  },
  whenReady: () => state.setup || Promise.resolve(state.ids),

  // ---- Circle
  async circlePay(protoId, i) {
    const id = circleId(protoId);
    if (i === 0) return chain.circle.pay(id);
    return post('/api/bot', { action: 'pay', who: NAMES[i], id });
  },
  async circlePayout(protoId, co) {
    return chain.circle.payout(circleId(protoId), await addrOf(co), NAMES[co]);
  },
  park: (protoId) => chain.circle.park(circleId(protoId)),
  joinDeposit: (protoId) => chain.circle.join(circleId(protoId)),
  advance: (protoId, usd) => chain.circle.advance(circleId(protoId), usd),
  async combo(protoId, co, debts, billUsd, billTo) {
    const id = circleId(protoId);
    const c = await chain.circle.get(id);
    const meIdx = c.members.indexOf(state.wallet);
    if (meIdx >= 0 && !c.paid[meIdx]) await chain.circle.pay(id);
    const d = [];
    for (const t of debts) d.push({ to: await addrOf(t.to), amount: Math.floor(t.usd * 1e6) / 1e6 });
    return chain.circle.payoutCombo(id, await addrOf(co), NAMES[co], state.ids.s1, d, billTo || null, billUsd || 0);
  },

  // ---- Settle
  async addExpense(who, usd, parts, memo) {
    const p = []; for (const i of parts) p.push(await addrOf(i));
    if (who === 0) return chain.settle.addExpense(state.ids.s1, Math.round(usd * 1e6) / 1e6, p, memo);
    return onboard('expense', { group: state.ids.s1, expense: { payer: who, usd, parts, memo } }).then((r) => ({ hash: r.hashes[0] }));
  },
  /** You approve (with a capped allowance if you owe), then family members approve until half the group has. */
  async settle() {
    const g = state.ids.s1;
    const owe = Number(await chain.view('settle', 'needed_allowance', [chain.sv.u32(g), chain.sv.addr(state.wallet)])) / 1e7;
    if (owe > 0) await chain.approveUsdc(chain.CFG.settle, owe + 1);
    let r = await chain.settle.approve(g);
    const grp = await chain.settle.get(g);
    const need = Math.ceil(grp.members.length / 2);
    let n = grp.approvals.length;
    for (const i of [1, 2, 3, 4, 5]) {
      if (n >= need) break;
      r = await post('/api/bot', { action: 'approve', who: NAMES[i], id: g });
      n += 1;
    }
    return r;
  },

  // ---- Cover and claim links
  payBill: async (usd, toIdx = 5) => chain.call('usdc', 'transfer', [chain.sv.addr(state.wallet), chain.sv.addr(await addrOf(toIdx)), chain.sv.i128(chain.toUnits(Math.round(usd * 1e6) / 1e6))]),
  claimCreate: (usd) => chain.claim.create(Math.round(usd * 1e6) / 1e6),
  claimBack: (id) => chain.claim.back(id),
  claimRedeem: (id, secret) => chain.claim.redeem(id, secret),
  balance: () => chain.usdcBalance(),
};

window.TMLive = Live;
export default Live;
