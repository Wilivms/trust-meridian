// Deploys the XOXNO-backed DeFindex strategy, creates a DeFindex vault for
// Circle USDC through the official DeFindex factory, and points Circle at it.
import fs from 'node:fs';
import { xdr, nativeToScVal } from '@stellar/stellar-sdk';
import { key, upload, deploy, invoke, sv } from './stellar.mjs';
const D = JSON.parse(fs.readFileSync('deployments/testnet.json'));
const FACTORY = 'CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32';
const SOROSWAP_ROUTER = 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD';
const admin = key('admin');
const S = (o) => xdr.ScVal.scvMap(Object.keys(o).sort().map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: o[k] })));
if (!D.strategy) {
  const h = await upload(admin, 'target/wasm32v1-none/release/tm_xoxno_strategy.wasm');
  D.strategy = await deploy(admin, h, [sv.addr(D.usdc), xdr.ScVal.scvVec([sv.addr(D.xoxno.controller), sv.addr(D.xoxno.pool), sv.addr(D.xoxno.position_nft), sv.u32(1), sv.u32(1)])]);
  console.log('strategy', D.strategy);
  fs.writeFileSync('deployments/testnet.json', JSON.stringify(D, null, 2));
}
if (!D.vault) {
  const roles = xdr.ScVal.scvMap([0, 1, 2, 3].map((i) => new xdr.ScMapEntry({ key: sv.u32(i), val: sv.addr(admin.publicKey()) })));
  const assets = xdr.ScVal.scvVec([S({ address: sv.addr(D.usdc), strategies: xdr.ScVal.scvVec([S({ address: sv.addr(D.strategy), name: sv.str('XOXNO USDC supply'), paused: nativeToScVal(false) })]) })]);
  const names = xdr.ScVal.scvMap([['name', 'TM Circle'], ['symbol', 'TMCP']].map(([k, v]) => new xdr.ScMapEntry({ key: sv.str(k), val: sv.str(v) })));
  const r = await invoke(admin, FACTORY, 'create_defindex_vault', [roles, sv.u32(0), assets, sv.addr(SOROSWAP_ROUTER), names, nativeToScVal(false)]);
  D.vault = r.ret;
  console.log('vault', D.vault, r.hash);
  fs.writeFileSync('deployments/testnet.json', JSON.stringify(D, null, 2));
}
const r = await invoke(admin, D.circle, 'set_vault', [sv.addr(D.vault)]);
console.log('circle.set_vault', r.hash);
