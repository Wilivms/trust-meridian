// Cover · a help request is saved in Supabase (who it is for, the payee, the
// amount, the bill's fingerprint). The money itself only moves on-chain.
import { createClient } from '@supabase/supabase-js';
import { json } from './_lib.js';

const db = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const str = (v, n) => (v == null ? null : String(v).slice(0, n));

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { data, error } = await db().from('requests').select('*').order('created_at', { ascending: false }).limit(30);
      if (error) throw error;
      return json(res, 200, { requests: data });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const amount = Number(b.amount);
    if (!b.for_name || !b.title || !b.payee || !(amount > 0)) return json(res, 400, { error: 'for_name, title, payee and amount are required' });
    const row = {
      by_wallet: str(b.by_wallet, 64) || 'guest', for_name: str(b.for_name, 40), city: str(b.city, 40) || '', kind: str(b.kind, 20) || 'Other',
      title: str(b.title, 80), payee: str(b.payee, 80), amount, currency: str(b.currency, 8) || 'USDC', usdc: Number(b.usdc) || null,
      message: str(b.message, 280), bill_hash: /^[0-9a-f]{64}$/.test(b.bill_hash || '') ? b.bill_hash : null,
    };
    const { data, error } = await db().from('requests').insert(row).select('id').single();
    if (error) throw error;
    return json(res, 200, { id: data.id });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
}
