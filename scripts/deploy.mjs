// Uploads and deploys Settle, Circle and Claim, then plugs Circle into XOXNO.
import fs from 'node:fs';
import { key, upload, deploy, invoke, sv } from './stellar.mjs';
import { xdr } from '@stellar/stellar-sdk';
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'; // Circle USDC (testnet SAC)
const XOXNO = { controller: 'CCXRWJ6SIU2WPFEGLFGJVITPL57QAYIMIO6OAM2NBGNDQSSCK2FFV3F3', pool: 'CBSGF6QOQAMPFBEVSYPEQHSZRIHJ6RCGUPCRDMUX36DEKRWFAO2PZB5A', position_nft: 'CDVN5JU675MEDPVRPCYC45AHFC275UH57WEU5OTFE4WFGZBNN7HTLPSY' };
const W = 'target/wasm32v1-none/release';
const admin = key('admin'), treasury = key('treasury');
const out = fs.existsSync('deployments/testnet.json') ? JSON.parse(fs.readFileSync('deployments/testnet.json')) : {};
const only = process.argv.slice(2);
const want = (n) => !only.length || only.includes(n);
const S = (o) => xdr.ScVal.scvMap(Object.keys(o).sort().map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: o[k] })));
if (want('settle')) out.settle = await deploy(admin, await upload(admin, `${W}/tm_settle.wasm`), [sv.addr(USDC)]);
if (want('circle')) out.circle = await deploy(admin, await upload(admin, `${W}/tm_circle.wasm`), [sv.addr(admin.publicKey()), sv.addr(USDC), sv.addr(out.settle)]);
if (want('claim')) out.claim = await deploy(admin, await upload(admin, `${W}/tm_claim.wasm`), [sv.addr(USDC), sv.addr(treasury.publicKey()), sv.i128(1_000_000)]);
if (want('circle') || want('lending')) {
  const cfg = S({
    addresses: S({ controller: sv.addr(XOXNO.controller), pool: sv.addr(XOXNO.pool), position_nft: sv.addr(XOXNO.position_nft) }),
    market: S({ asset: sv.addr(USDC), hub_id: sv.u32(1) }),
    spoke_id: sv.u32(1),
  });
  await invoke(admin, out.circle, 'set_lending', [cfg]);
}
Object.assign(out, { network: 'testnet', usdc: USDC, admin: admin.publicKey(), treasury: treasury.publicKey(), xoxno: XOXNO });
fs.mkdirSync('deployments', { recursive: true });
fs.writeFileSync('deployments/testnet.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
