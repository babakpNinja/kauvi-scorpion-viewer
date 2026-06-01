import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

const app = express();
app.use(express.json({ limit: '256kb' }));

// Static files
app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.stl')) res.setHeader('Content-Type', 'model/stl');
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, model: MODEL, hasKey: !!ANTHROPIC_KEY });
});

const SYSTEM_PROMPT = `You are the AI builder inside Kauvi 3D Studio, a 3D modeling app for an 11-year-old kid named Kauvi who loves 3D printing. You help him build things by emitting a structured action plan.

CRITICAL: You MUST reply with PURE JSON ONLY. No prose, no markdown fences, no explanation outside the JSON. The JSON shape:
{
  "reply": "<one short friendly sentence to the kid explaining what you built>",
  "commands": [<list of action objects>]
}

Valid command actions:
- {"action":"add", "kind":"<shape>", "color":"#hex", "size":<num>, "position":[x,y,z], "rotation":[x,y,z]?, "scale":[sx,sy,sz]?}
- {"action":"template", "name":"<rocket|house|robot|castle|car|plane|tree|sword|cat|spaceship>"}
- {"action":"clear"}
- {"action":"setBackground", "color":"#hex"}
- {"action":"color", "color":"#hex"}
- {"action":"showImage", "prompt":"<short description for the artist>"}  — use when the kid asks for a "reference", "picture of", "what does X look like", or seems to want visual inspiration before building.

Valid shape kinds: box, sphere, cylinder, cone, pyramid, torus, halfsphere, wedge, prism, star.

Coordinate convention: +Y is up. Y=0 is the floor. 1 unit = 1 mm. Default size 20.

Rules:
- Build creatively. Use 5 to 15 shapes for "build me a X" asks.
- Use bright kid-friendly colors. Match the ask. Red rocket = "#dc2626" body. Etc.
- Stack pieces sensibly: a sphere head on a box body, wheels at y=6 with z=±16.
- If the kid asks for a template by name, use action=template instead of building from scratch.
- If unclear, build something fun anyway and explain.
- Reply text under 100 chars, kid-friendly tone.

Example response for "make a red rocket":
{"reply":"Built you a red rocket with fins and flames!","commands":[{"action":"clear"},{"action":"add","kind":"cylinder","color":"#dc2626","size":30,"position":[0,35,0],"scale":[1,2.5,1]},{"action":"add","kind":"cone","color":"#dc2626","size":30,"position":[0,85,0],"scale":[1,1.2,1]},{"action":"add","kind":"sphere","color":"#60a5fa","size":10,"position":[0,50,14]}]}`;

app.post('/api/chat', async (req, res) => {
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });
  }
  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (incoming.length === 0) {
    return res.status(400).json({ ok: false, error: 'messages array required' });
  }
  const lastUser = incoming[incoming.length - 1];
  console.log(new Date().toISOString(), 'chat:', (lastUser?.content || '').slice(0, 100));

  // Sanitize: only pass role+content fields, max last 12 turns
  const messages = incoming.slice(-12).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 4000)
  }));

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('anthropic error', resp.status, errText.slice(0, 200));
      return res.status(502).json({ ok: false, error: 'anthropic_api_error', status: resp.status, detail: errText.slice(0, 500) });
    }
    const data = await resp.json();
    const text = (data?.content?.[0]?.text || '').trim();
    // Strip any markdown code fences if model emits them
    let cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let plan;
    try {
      plan = JSON.parse(cleaned);
    } catch (e) {
      return res.json({ ok: false, raw: text, error: 'parse_error', detail: e.message });
    }
    if (!Array.isArray(plan.commands)) plan.commands = [];
    if (typeof plan.reply !== 'string') plan.reply = 'Built it!';
    res.json({ ok: true, plan, usage: data?.usage });
  } catch (e) {
    console.error('chat err', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === Image generation (DALL-E 3) ===
const OPENAI_KEY = process.env.OPENAI_API_KEY;
app.post('/api/image', async (req, res) => {
  if (!OPENAI_KEY) {
    return res.status(500).json({ ok: false, error: 'OPENAI_API_KEY not set' });
  }
  const userPrompt = String(req.body?.prompt || '').slice(0, 400).trim();
  if (!userPrompt) return res.status(400).json({ ok: false, error: 'prompt required' });
  const size = ['1024x1024', '1792x1024', '1024x1792'].includes(req.body?.size) ? req.body.size : '1024x1024';
  const wrapped = 'A simple, kid-friendly, brightly colored 3D-printable model of: ' + userPrompt + '. Clean studio lighting, white background, isometric angle, clear shapes, no text labels.';
  console.log(new Date().toISOString(), 'image:', userPrompt.slice(0, 80));
  try {
    const resp = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + OPENAI_KEY
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: wrapped,
        n: 1,
        size,
        quality: 'medium'
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('openai image error', resp.status, errText.slice(0, 200));
      return res.status(502).json({ ok: false, error: 'openai_api_error', status: resp.status, detail: errText.slice(0, 400) });
    }
    const data = await resp.json();
    const item = data?.data?.[0] || {};
    let url = item.url;
    if (!url && item.b64_json) url = 'data:image/png;base64,' + item.b64_json;
    const revisedPrompt = item.revised_prompt;
    if (!url) return res.status(502).json({ ok: false, error: 'no_url_in_response', raw: data });
    res.json({ ok: true, url, prompt: userPrompt, revisedPrompt });
  } catch (e) {
    console.error('image err', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// SPA fallback to index.html
app.get('*', async (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  try {
    const html = await readFile(path.join(__dirname, 'index.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(404).send('Not found');
  }
});

app.listen(PORT, () => {
  console.log('Kauvi 3D Studio server listening on', PORT, 'model:', MODEL, 'hasKey:', !!ANTHROPIC_KEY);
});
