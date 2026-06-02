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

If the kid sends an *image* (a drawing, sketch, or photo), look at it carefully and decide what 3D model would best represent the subject. Tell them what you see in one short sentence (e.g. "I see a dog with floppy ears!"), then emit build commands that recreate it in shapes. Pick colors that match the drawing. Keep proportions sensible. Always start with action:"clear" before building from an image.

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

  // Sanitize + build multimodal content where image is attached.
  // Accepted shapes per turn:
  //   { role, content: "string" }                    -> plain text
  //   { role, content: "string", image: "data:..." } -> text + image (Sonnet vision)
  const messages = incoming.slice(-12).map(m => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const text = String(m.content || '').slice(0, 4000);
    if (m.image && typeof m.image === 'string' && m.image.startsWith('data:image/')) {
      const match = m.image.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/);
      if (match) {
        const mediaType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
        const b64 = match[2];
        // Cap raw base64 at 8 MB worth (~10.6M chars). Skip image if oversized.
        if (b64.length <= 10_600_000) {
          return {
            role,
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
              { type: 'text', text: text || 'Build this drawing in 3D shapes.' }
            ]
          };
        }
      }
    }
    return { role, content: text };
  });

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
        max_tokens: 2048,
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

// === Share link: persistent scene store with short ID ===
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const SHARES_PATH = '/tmp/kauvi-shares.json';
const MAX_SHARES = 200;
const SHARE_MAX_BYTES = 500_000;
const shares = new Map();
try {
  if (existsSync(SHARES_PATH)) {
    const raw = JSON.parse(readFileSync(SHARES_PATH, 'utf8'));
    for (const [id, scene] of Object.entries(raw)) shares.set(id, scene);
    console.log('loaded', shares.size, 'shares from disk');
  }
} catch (e) { console.warn('share load failed', e.message); }
function persistShares() {
  try {
    const obj = Object.fromEntries(shares.entries());
    writeFileSync(SHARES_PATH, JSON.stringify(obj));
  } catch (e) { console.warn('share persist failed', e.message); }
}
function randomShareId(len = 6) {
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alpha[Math.floor(Math.random() * alpha.length)];
  return s;
}

app.post('/api/share', (req, res) => {
  const scene = req.body?.scene;
  if (!scene || typeof scene !== 'object') return res.status(400).json({ ok: false, error: 'scene object required' });
  const json = JSON.stringify(scene);
  if (json.length > SHARE_MAX_BYTES) return res.status(413).json({ ok: false, error: 'scene too large (max 500KB)' });
  let id;
  for (let i = 0; i < 6; i++) { id = randomShareId(); if (!shares.has(id)) break; }
  shares.set(id, scene);
  // LRU evict: oldest first
  while (shares.size > MAX_SHARES) {
    const oldestKey = shares.keys().next().value;
    if (oldestKey !== undefined) shares.delete(oldestKey); else break;
  }
  persistShares();
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host || req.get?.('host') || 'viewer-production-e90c.up.railway.app';
  const url = proto + '://' + host + '/share/' + id;
  res.json({ ok: true, id, url });
});

app.get('/api/share/:id', (req, res) => {
  const scene = shares.get(req.params.id);
  if (!scene) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, scene });
});

app.get('/share/:id', async (req, res, next) => {
  try {
    const id = req.params.id.replace(/[^a-z0-9]/gi, '').slice(0, 8);
    if (!id || !shares.has(id)) return next();
    let html = await readFile(path.join(__dirname, 'index.html'), 'utf8');
    const inject = `
<script id="share-bootstrap">
(function(){
  function tryApply() {
    if (typeof window._applyShareSnapshot === 'function') {
      fetch('/api/share/${id}').then(r => r.json()).then(data => {
        if (data.ok && data.scene) window._applyShareSnapshot(data.scene);
      });
      return true;
    }
    return false;
  }
  if (!tryApply()) {
    const iv = setInterval(() => { if (tryApply()) clearInterval(iv); }, 300);
    setTimeout(() => clearInterval(iv), 15000);
  }
})();
</script>`;
    html = html.replace('</body>', inject + '\n</body>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { next(); }
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
