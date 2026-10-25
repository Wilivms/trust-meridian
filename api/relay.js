// Fee-sponsored submission for passkey wallets (smart-account-kit relayerUrl).
import { relay, allowed, json } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'GET') return json(res, 200, { ok: true });
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (body.func && !allowed(body.func)) return json(res, 403, { error: 'Call not allowed' });
    const r = await relay(body);
    return json(res, 200, r);
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
}
