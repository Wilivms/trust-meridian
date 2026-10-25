// "In plain words": Claude sums up a combined payout in one sentence before
// the user confirms. The structured detail stays on screen; this is a summary.
import Anthropic from '@anthropic-ai/sdk';
import { json } from './_lib.js';

const MODEL = process.env.CLAUDE_FAST_MODEL || 'claude-haiku-5-5';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 120,
      system: 'You explain a transaction to a family member in ONE short plain English sentence, with every amount in USDC exactly as given. No jargon, no advice, no emoji.',
      messages: [{ role: 'user', content: JSON.stringify(body.steps || body) }],
    });
    return json(res, 200, { text: msg.content.map((c) => c.text || '').join('').trim() });
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
}
