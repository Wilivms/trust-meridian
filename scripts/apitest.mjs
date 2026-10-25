// Calls the Vercel handlers locally against testnet.
import fs from 'node:fs';
const D = JSON.parse(fs.readFileSync('deployments/testnet.json'));
const sec = (n) => fs.readFileSync(`.secrets/${n}.key`, 'utf8').trim();
Object.assign(process.env, {
  VITE_CIRCLE_ID: D.circle, VITE_SETTLE_ID: D.settle, VITE_CLAIM_ID: D.claim, VITE_USDC_ID: D.usdc,
  SPONSOR_SECRETS: JSON.stringify([sec('treasury')]), TREASURY_SECRET: sec('treasury'),
  BOT_SECRETS: JSON.stringify(Object.fromEntries(['lea', 'hugo', 'ines', 'noah', 'emma'].map((n) => [n, sec(n)]))),
});
const call = async (mod, body) => {
  const h = (await import(`../api/${mod}.js`)).default;
  let out; const res = { status(c) { this.c = c; return this; }, setHeader() { return this; }, send(b) { out = { code: this.c, body: JSON.parse(b) }; } };
  await h({ method: 'POST', body }, res); return out;
};
const [mod, json] = process.argv.slice(2);
console.log(JSON.stringify(await call(mod, JSON.parse(json))));
