// Cover · "Snap the bill": Claude reads a bill photo and returns the fields
// that pre-fill a help request. The photo is not stored; only its SHA-256
// fingerprint is returned, to be attached to the on-chain request.
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { json } from './_lib.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const data = String(body.image || '').replace(/^data:[^;]+;base64,/, '');
    const media = body.mediaType || 'image/jpeg';
    if (!data || data.length > 7_000_000) return json(res, 400, { error: 'Send one image under 5 MB' });
    const fingerprint = createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: 'You read household bills (electricity, water, school fees, rent, pharmacy) from photos for a family payments app. Reply with JSON only.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media, data } },
          { type: 'text', text: 'Extract: {"payee": provider name, "customer": name on the bill, "amount": number, "currency": ISO code (BRL, NGN, EUR, JPY, AUD, USD...), "due": due date ISO yyyy-mm-dd or null, "reference": bill or customer reference or null, "kind": one of School, Health, Electricity, Rent, Other, "title": short English title like "Electricity, October bill", "confidence": 0-1}. If a field is unreadable use null. JSON only.' },
        ],
      }],
    });
    const text = msg.content.map((c) => c.text || '').join('');
    const m = /\{[\s\S]*\}/.exec(text);
    const fields = m ? JSON.parse(m[0]) : null;
    if (!fields) return json(res, 422, { error: 'Could not read the bill' });
    return json(res, 200, { fields, fingerprint, model: MODEL });
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
}
