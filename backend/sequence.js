import cron from 'node-cron';
import fetch from 'node-fetch';

// ── CONFIG ───────────────────────────────────────────────────────────────────
const NOCODB_BASE   = process.env.NOCODB_BASE   || 'https://whizz.aiingo.com';
const NOCODB_TOKEN  = process.env.NOCODB_TOKEN  || '';
const CLIENTS_TABLE = process.env.CLIENTS_TABLE || 'mxl33bg4wi70fqj';
const POLL_LOOKBACK_MIN = 30; // only consider conversations created within this window

// ── HELPERS ──────────────────────────────────────────────────────────────────
const ncHdr = () => ({ 'xc-token': NOCODB_TOKEN, 'Content-Type': 'application/json' });

async function ncGet(url) {
  const r = await fetch(url, { headers: ncHdr() });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

async function ncPatch(url, body) {
  const r = await fetch(url, { method: 'PATCH', headers: ncHdr(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PATCH ${url} → ${r.status}`);
  return r.json();
}

async function fetchActiveClients() {
  let all = [], page = 1;
  while (true) {
    const url = `${NOCODB_BASE}/api/v2/tables/${CLIENTS_TABLE}/records?limit=100&offset=${(page-1)*100}`;
    const data = await ncGet(url);
    const rows = data.list || [];
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < 100) break;
    page++;
  }
  return all.filter(c => (c.active || 'Yes') === 'Yes' && (c.seq_enabled || 'No') === 'Yes'
    && c.chatwoot_base && c.chatwoot_account_id && c.chatwoot_token);
}

async function cwGet(client, path) {
  const r = await fetch(`${client.chatwoot_base.replace(/\/$/, '')}${path}`, {
    headers: { api_access_token: client.chatwoot_token },
  });
  if (!r.ok) throw new Error(`Chatwoot GET ${path} → ${r.status}`);
  return r.json();
}

async function cwSendText(client, convId, content) {
  const r = await fetch(`${client.chatwoot_base.replace(/\/$/, '')}/api/v1/accounts/${client.chatwoot_account_id}/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { api_access_token: client.chatwoot_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, message_type: 'outgoing', private: false }),
  });
  if (!r.ok) throw new Error(`Chatwoot send text → ${r.status}`);
  return r.json();
}

async function cwSendMedia(client, convId, mediaUrl, caption) {
  const mediaRes = await fetch(mediaUrl);
  if (!mediaRes.ok) throw new Error(`Fetch media → ${mediaRes.status}`);
  const buf = Buffer.from(await mediaRes.arrayBuffer());
  const filename = mediaUrl.split('/').pop().split('?')[0] || 'demo.mp4';

  const form = new FormData();
  form.append('message_type', 'outgoing');
  form.append('private', 'false');
  form.append('content', caption || '');
  form.append('attachments[]', new Blob([buf]), filename);

  const r = await fetch(`${client.chatwoot_base.replace(/\/$/, '')}/api/v1/accounts/${client.chatwoot_account_id}/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { api_access_token: client.chatwoot_token },
    body: form,
  });
  if (!r.ok) throw new Error(`Chatwoot send media → ${r.status}`);
  return r.json();
}

async function cwSetCustomAttrs(client, convId, attrs) {
  const r = await fetch(`${client.chatwoot_base.replace(/\/$/, '')}/api/v1/accounts/${client.chatwoot_account_id}/conversations/${convId}/custom_attributes`, {
    method: 'POST',
    headers: { api_access_token: client.chatwoot_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom_attributes: attrs }),
  });
  if (!r.ok) throw new Error(`Chatwoot custom_attributes → ${r.status}`);
  return r.json();
}

async function aiPersonaliseIntro(client, contactName) {
  const orKey = client.openrouter_key || '';
  const model = client.model || 'google/gemini-2.5-flash';
  const fallback = (client.seq_intro_msg || `Hi! Welcome to ${client.client_name}. How can I help you?`)
    .replace('{{business_name}}', client.client_name || '')
    .replace('{{contact_name}}', contactName || 'there');
  if (!orKey) return fallback;

  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 120,
        messages: [
          { role: 'system', content: `You are a warm, friendly WhatsApp sales assistant for ${client.client_name} (${client.industry} business). Write a SHORT personalised greeting (2-3 sentences max) for a new WhatsApp contact. Use their name if available. Sound human and welcoming, not robotic. End with a natural open question relevant to the business. Return ONLY the message text — no quotes, no explanation.` },
          { role: 'user', content: `Contact name: ${contactName || 'unknown'}\nBusiness name: ${client.client_name}\nIndustry: ${client.industry}\nBase template (optional reference): ${client.seq_intro_msg || 'none'}` },
        ],
      }),
    });
    const data = await r.json();
    return data.choices?.[0]?.message?.content?.trim() || fallback;
  } catch (e) {
    console.warn('  AI personalise failed, using fallback:', e.message);
    return fallback;
  }
}

// ── PER-CLIENT PASS ──────────────────────────────────────────────────────────
async function processClient(client) {
  const introDelay = parseInt(client.seq_intro_delay) || 60;   // seconds
  const demoDelay  = parseInt(client.seq_demo_delay)  || 90;   // seconds
  const demoUrl    = client.seq_demo_video_url || '';
  const caption    = client.seq_demo_caption   || '';
  const cutoff     = new Date(Date.now() - POLL_LOOKBACK_MIN * 60 * 1000);

  let convos;
  try {
    const data = await cwGet(client, `/api/v1/accounts/${client.chatwoot_account_id}/conversations?status=all`);
    convos = data.data?.payload || data.payload || [];
  } catch (e) {
    console.warn(`  [${client.client_name}] conversation fetch failed: ${e.message}`);
    return;
  }

  for (const conv of convos) {
    const createdAt = new Date((conv.created_at || conv.timestamp || 0) * 1000);
    if (createdAt < cutoff) continue;

    const attrs = conv.custom_attributes || {};
    if (attrs.seq_done) continue;

    const sender = conv.meta?.sender || {};
    const contactName = sender.name || '';
    const introSentAt = attrs.seq_intro_sent_at ? new Date(attrs.seq_intro_sent_at) : null;

    try {
      if (!introSentAt) {
        // first sighting — wait until enough real time has passed since creation
        if ((Date.now() - createdAt.getTime()) / 1000 < introDelay) continue;

        const introMsg = await aiPersonaliseIntro(client, contactName);
        await cwSendText(client, conv.id, introMsg);
        await cwSetCustomAttrs(client, conv.id, { seq_intro_sent_at: new Date().toISOString() });
        await ncPatch(`${NOCODB_BASE}/api/v2/tables/${CLIENTS_TABLE}/records/${client.Id}`, {
          seq_stat_sent: (parseInt(client.seq_stat_sent || 0) + 1),
          seq_last_triggered: new Date().toISOString(),
        });
        console.log(`  [${client.client_name}] sent intro → conv ${conv.id}`);

        if (!demoUrl) {
          await cwSetCustomAttrs(client, conv.id, { seq_intro_sent_at: new Date().toISOString(), seq_done: true });
        }
        continue;
      }

      if (demoUrl && !attrs.seq_demo_sent_at) {
        if ((Date.now() - introSentAt.getTime()) / 1000 < demoDelay) continue;

        await cwSendMedia(client, conv.id, demoUrl, caption);
        await cwSetCustomAttrs(client, conv.id, {
          seq_intro_sent_at: attrs.seq_intro_sent_at,
          seq_demo_sent_at: new Date().toISOString(),
          seq_done: true,
        });
        await ncPatch(`${NOCODB_BASE}/api/v2/tables/${CLIENTS_TABLE}/records/${client.Id}`, {
          seq_stat_demo: (parseInt(client.seq_stat_demo || 0) + 1),
        });
        console.log(`  [${client.client_name}] sent demo → conv ${conv.id}`);
      }
    } catch (e) {
      console.warn(`  [${client.client_name}] conv ${conv.id} failed: ${e.message}`);
    }
  }
}

// ── MAIN LOOP ────────────────────────────────────────────────────────────────
async function runOnce() {
  console.log(`\n[sequence] poll @ ${new Date().toISOString()}`);
  if (!NOCODB_TOKEN) { console.error('NOCODB_TOKEN not set'); return; }

  const clients = await fetchActiveClients();
  console.log(`  ${clients.length} client(s) with sequence enabled`);
  for (const client of clients) {
    await processClient(client).catch(e => console.warn(`  [${client.client_name}] error: ${e.message}`));
  }
}

if (process.env.RUN_NOW === '1') {
  runOnce().then(() => process.exit(0));
} else {
  cron.schedule('* * * * *', runOnce); // every 1 minute
  console.log('[sequence] poller started — running every 1 minute');
  runOnce();
}
