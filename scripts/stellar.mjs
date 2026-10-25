// Small Stellar helpers for scripts (Node, stellar-sdk).
import { Keypair, rpc, TransactionBuilder, Operation, Address, nativeToScVal, scValToNative, xdr, BASE_FEE } from '@stellar/stellar-sdk';
import fs from 'node:fs';
export const RPC = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
export const PASS = 'Test SDF Network ; September 2015';
export const server = new rpc.Server(RPC);

export function key(name) {
  fs.mkdirSync('.secrets', { recursive: true });
  const p = `.secrets/${name}.key`;
  if (process.env[`${name.toUpperCase()}_SECRET`]) return Keypair.fromSecret(process.env[`${name.toUpperCase()}_SECRET`]);
  if (fs.existsSync(p)) return Keypair.fromSecret(fs.readFileSync(p, 'utf8').trim());
  const kp = Keypair.random(); fs.writeFileSync(p, kp.secret(), { mode: 0o600 }); return kp;
}
export async function fund(pub) {
  try { await server.getAccount(pub); return false; } catch {}
  const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`); if (!r.ok) throw new Error('friendbot ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return true;
}
export async function send(kp, op, { auth } = {}) {
  const acct = await server.getAccount(kp.publicKey());
  const isSoroban = /HostFunction|Wasm|Contract/.test(op.body().switch().name);
  let tx = new TransactionBuilder(acct, { fee: '1000', networkPassphrase: PASS }).addOperation(op).setTimeout(300).build();
  let envelope;
  if (isSoroban) {
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error('simulate: ' + sim.error);
    const resFee = BigInt(sim.minResourceFee) * 115n / 100n;
    const data = sim.transactionData.build();
    data.resourceFee(new xdr.Int64(resFee));
    const auth0 = sim.result ? sim.result.auth : [];
    const op2 = Operation.invokeHostFunction({ func: tx.operations[0].func, auth: auth0 });
    const acct2 = await server.getAccount(kp.publicKey());
    if (resFee + 1000n < 4_000_000_000n) {
      envelope = new TransactionBuilder(acct2, { fee: String(resFee + 1000n), networkPassphrase: PASS, sorobanData: data }).addOperation(op2).setTimeout(300).build();
      envelope.sign(kp);
    } else {
      // Resource fee above uint32: wrap in a fee bump (int64 fee).
      const plain = new TransactionBuilder(acct2, { fee: '1000', networkPassphrase: PASS }).addOperation(op2).setTimeout(300).build();
      const env = plain.toEnvelope();
      env.v1().tx().ext(new xdr.TransactionExt(1, data));
      const inner = TransactionBuilder.fromXDR(env.toXDR('base64'), PASS);
      inner.sign(kp);
      envelope = TransactionBuilder.buildFeeBumpTransaction(kp, String(resFee + 10000n), inner, PASS);
      envelope.sign(kp);
    }
  } else { tx.sign(kp); envelope = tx; }
  const s = await server.sendTransaction(envelope);
  if (s.status === 'ERROR') throw new Error('send: ' + (s.errorResult ? s.errorResult.toXDR('base64') : JSON.stringify(s)));
  for (let i = 0; i < 90; i++) {
    const g = await server.getTransaction(s.hash);
    if (g.status === 'SUCCESS') return { hash: s.hash, ret: g.returnValue ? scValToNative(g.returnValue) : null, rv: g.returnValue };
    if (g.status === 'FAILED') throw new Error('failed ' + s.hash + ' ' + (g.resultXdr ? g.resultXdr.toXDR('base64') : ''));
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('timeout ' + s.hash);
}
export async function upload(kp, file) {
  const r = await send(kp, Operation.uploadContractWasm({ wasm: fs.readFileSync(file) }));
  return Buffer.from(r.ret).toString('hex');
}
export async function deploy(kp, wasmHash, args) {
  const r = await send(kp, Operation.createCustomContract({ address: new Address(kp.publicKey()), wasmHash: Buffer.from(wasmHash, 'hex'), constructorArgs: args, salt: Keypair.random().rawPublicKey() }));
  return Address.fromScVal(r.rv).toString();
}
export function invokeOp(id, method, args) { return Operation.invokeContractFunction({ contract: id, function: method, args }); }
export async function invoke(kp, id, method, args = []) { return send(kp, invokeOp(id, method, args)); }
export async function read(id, method, args = []) {
  const acct = new (await import('@stellar/stellar-sdk')).Account(Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASS }).addOperation(invokeOp(id, method, args)).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return scValToNative(sim.result.retval);
}
export const sv = {
  addr: (a) => new Address(a).toScVal(), u32: (n) => nativeToScVal(n, { type: 'u32' }), i128: (n) => nativeToScVal(BigInt(n), { type: 'i128' }),
  str: (s) => nativeToScVal(s, { type: 'string' }), bool: (b) => nativeToScVal(b), sym: (s) => xdr.ScVal.scvSymbol(s),
};
