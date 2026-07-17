import cron from 'node-cron';
import fetch from 'node-fetch';

// ── WHAT THIS IS ─────────────────────────────────────────────────────────────
// Standalone recovery/win-back engine. Runs entirely separately from the n8n
// bot engine and from nba.js — it only reads the clients table and reads/patches
// brand-new `recovery_*` fields on the leads table. It never touches Stage,
// ConvHistory, LastMsgAt, or any field the bot engine relies on, so it cannot
// break live conversations.
//
// Merges two features into one escalating drip, keyed off silence:
//   1. Abandoned-conversation recovery — early, soft check-in once a lead goes
//      quiet mid-funnel.
//   2. Cold win-back — later-stage, higher-effort last-chance message for
//      leads that stay silent through the first nudge too.
//
// If a client already has the classic templated follow-up (`followup_count`
// on the clients table, driven by followup-template.json) configured, this
// engine waits until that sequence is exhausted before starting its own
// ladder, so a lead never gets double-messaged by two systems at once.

// ── CONFIG ───────────────────────────────────────────────────────────────────
const NOCODB_BASE     = process.env.NOCODB_BASE     || 'https://whizz.aiingo.com';
const NOCODB_TOKEN    = process.env.NOCODB_TOKEN    || '';
const CLIENTS_TABLE   = process.env.CLIENTS_TABLE   || 'mxl33bg4wi70fqj';
const LOOKBACK_DAYS   = parseInt(process.env.RECOVERY_LOOKBACK_DAYS || '60'); // ignore leads older than this
const SEND_DELAY_MS   = parseInt(process.env.RECOVERY_SEND_DELAY_MS || '600'); // pacing between sends
const AI_TIMEOUT_MS   = 10000;
// Voice Follow-ups (Settings → Voice, client.voice_followup_enabled) — same Sarvam AI pipeline the
// Cloudflare Worker uses for live voice-to-voice replies (cloudflare-worker/worker.js), ported here
// since this is a separate Node process with no access to that Worker's own secrets/helpers. One
// shared key for all clients, same pattern as NOCODB_TOKEN above — not per-client.
const SARVAM_API_KEY  = process.env.SARVAM_API_KEY  || '';

const TERMINAL_STAGES = new Set(['Converted', 'Lost', 'Closed', 'Opt Out']);

// Escalation ladder defaults — each entry is hours since the *previous* step
// (or since real last activity, for step 0). Clients can override via the
// optional `recovery_gaps_hours` / `recovery_messages` / `recovery_templates`
// fields on the clients table (see SETUP.md).
const DEFAULT_GAPS_HOURS = [6, 48, 168]; // 6h, then +48h, then +7d
const DEFAULT_MESSAGES = [
  'Hey {name}, just checking in — still around? Happy to help with any questions you had.',
  "Hi {name}, following up in case my last message got buried — is now still a good time, or is something holding you back?",
  "Hi {name}, this will be my last check-in for now. If you're still interested just reply and we'll pick up right where we left off — otherwise no worries at all!",
];

// ── NOCODB HELPERS ───────────────────────────────────────────────────────────
const ncHdr = (token) => ({ 'xc-token': token, 'Content-Type': 'application/json' });

async function ncGet(url, token) {
  const r = await fetch(url, { headers: ncHdr(token) });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

async function ncPatch(url, body, token) {
  const r = await fetch(url, { method: 'PATCH', headers: ncHdr(token), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PATCH ${url} → ${r.status}`);
  return r.json();
}

async function ncPost(url, body, token) {
  const r = await fetch(url, { method: 'POST', headers: ncHdr(token), body: JSON.stringify(body) });
  return r.json();
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ── FIELD AUTO-CREATE (isolated recovery_* namespace, never touches existing fields) ─
const RECOVERY_FIELDS = [
  { title: 'recovery_stage',           uidt: 'Number' },
  { title: 'recovery_done',            uidt: 'SingleLineText' },
  { title: 'recovery_last_sent_at',    uidt: 'DateTime' },
  { title: 'recovery_last_msg_snap',   uidt: 'DateTime' },
  { title: 'recovery_last_message',    uidt: 'LongText' },
];

async function ensureRecoveryFields(tableId, token) {
  try {
    const existing = await ncGet(`${NOCODB_BASE}/api/v2/meta/tables/${tableId}/fields`, token);
    const names = new Set((existing.list || []).map((f) => f.title));
    for (const field of RECOVERY_FIELDS) {
      if (!names.has(field.title)) {
        await ncPost(`${NOCODB_BASE}/api/v2/meta/tables/${tableId}/fields`, field, token);
        console.log(`  Created field "${field.title}" on table ${tableId}`);
      }
    }
  } catch (e) {
    console.warn(`  Could not ensure fields on ${tableId}: ${e.message}`);
  }
}

// ── FETCH ────────────────────────────────────────────────────────────────────
async function fetchClients() {
  const data = await ncGet(`${NOCODB_BASE}/api/v2/tables/${CLIENTS_TABLE}/records?limit=200`, NOCODB_TOKEN);
  return (data.list || []).filter((c) => c.active === 'Yes' || c.active === true);
}

async function fetchLeads(tableId, token) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
  const since = cutoff.toISOString().slice(0, 10);
  let all = [], page = 1;
  while (true) {
    const url = `${NOCODB_BASE}/api/v2/tables/${tableId}/records?limit=200&offset=${(page - 1) * 200}&sort=-Date`;
    const data = await ncGet(url, token);
    const rows = data.list || [];
    if (!rows.length) break;
    for (const r of rows) {
      if (TERMINAL_STAGES.has(r.Stage)) continue;
      if (r.Date && r.Date < since) continue;
      all.push(r);
    }
    if (rows.length < 200) break;
    page++;
  }
  return all;
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function hoursSince(isoStr) {
  if (!isoStr) return Infinity;
  const d = new Date(isoStr);
  if (isNaN(d)) return Infinity;
  return (Date.now() - d.getTime()) / 3600000;
}

function parseCsvNums(str, fallback) {
  if (!str) return fallback;
  const arr = String(str).split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
  return arr.length ? arr : fallback;
}

function parseLines(str, fallback) {
  if (!str) return fallback;
  const arr = String(str).split('\n').map((s) => s.trim()).filter(Boolean);
  return arr.length ? arr : fallback;
}

function truthy(v) {
  return v === true || v === 'Yes' || v === 'true' || v === 1 || v === '1';
}

function getConvId(lead) {
  return lead.ConversationID || lead.conv_id || lead.chatwoot_conv_id || lead.ConversationId || null;
}

// Regular templated follow-up (followup-template.json) still has budget left?
function regularFollowupsPending(lead, client) {
  const count = parseInt(client.followup_count || 0);
  if (!count) return false; // client has no classic follow-up sequence configured — nothing to wait on
  let sent = 0;
  for (let i = 0; i < Math.min(count, 3); i++) {
    if (truthy(lead['Follow up ' + (i + 1)])) sent++;
  }
  return sent < count;
}

// ── DECIDE: does this lead need a recovery message right now, and which stage? ─
function decide(lead, client) {
  if (TERMINAL_STAGES.has(lead.Stage)) return null;
  if (truthy(lead.OptOut)) return null;
  if (truthy(lead.Handover)) return null; // human is already on this conversation
  if (client.recovery_enabled === 'No' || client.recovery_enabled === false) return null;
  if (regularFollowupsPending(lead, client)) return null; // let the classic follow-up sequence finish first
  if (!getConvId(lead)) return null;

  const lastRealMs = lead.LastMsgAt || lead.Date;
  if (!lastRealMs) return null;

  const gaps = parseCsvNums(client.recovery_gaps_hours, DEFAULT_GAPS_HOURS);
  let stage = parseInt(lead.recovery_stage || 0);

  // If there's been genuine new activity since our last send (lead replied, or
  // the bot/agent otherwise engaged), the snapshot won't match — reset the ladder.
  const snap = lead.recovery_last_msg_snap;
  if (snap && new Date(snap).getTime() !== new Date(lastRealMs).getTime()) {
    stage = 0;
  }

  if (stage >= gaps.length) return null; // ladder already exhausted for this silence period

  const anchor = stage === 0 ? lastRealMs : lead.recovery_last_sent_at;
  if (!anchor) return null;
  if (hoursSince(anchor) < gaps[stage]) return null;

  const messages = parseLines(client.recovery_messages, DEFAULT_MESSAGES);
  const templates = parseLines(client.recovery_templates, []);

  return {
    stage,
    lastRealMs,
    message: (messages[stage] || messages[messages.length - 1]).replace('{name}', lead.Name || 'there'),
    templateName: templates[stage] || null,
  };
}

// ── AI PERSONALIZATION (best-effort, falls back to raw template on any failure) ─
async function personalize(baseMsg, lead, client) {
  if (!client.openrouter_key || !lead.ConvHistory) return baseMsg;
  try {
    let history = [];
    try { history = JSON.parse(lead.ConvHistory); } catch { /* ignore malformed history */ }
    const lastMsgs = history.slice(-6).map((m) => `${m.role}: ${m.content}`).join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${client.openrouter_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: client.model || 'google/gemini-2.5-flash',
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful sales assistant. Rewrite the given template into a SHORT, warm WhatsApp re-engagement message (1-2 sentences), personalised to the conversation context. Keep the same intent/urgency level as the template. Return ONLY the message text, no quotes.',
          },
          { role: 'user', content: `Template: ${baseMsg}\nRecent conversation:\n${lastMsgs || '(no history)'}` },
        ],
      }),
    });
    clearTimeout(timer);
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text && text.length > 5 ? text : baseMsg;
  } catch {
    return baseMsg; // never block a send on AI failure
  }
}

// ── SEND ─────────────────────────────────────────────────────────────────────
async function sendPlainMessage(client, convId, content) {
  const url = `${client.chatwoot_base}/api/v1/accounts/${client.chatwoot_account_id}/conversations/${convId}/messages`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { api_access_token: client.chatwoot_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, message_type: 'outgoing', private: false }),
  });
  if (!r.ok) throw new Error(`Chatwoot send failed → ${r.status}`);
  return r.json();
}

// For leads silent long enough that the WhatsApp 24h session window is closed,
// a plain text message will be rejected — an approved template must be used instead.
async function sendTemplateMessage(client, convId, templateName, leadName) {
  const url = `${client.chatwoot_base}/api/v1/accounts/${client.chatwoot_account_id}/conversations/${convId}/messages`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { api_access_token: client.chatwoot_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: templateName,
      message_type: 'outgoing',
      content_type: 'text',
      private: false,
      template_params: {
        name: templateName,
        category: 'MARKETING',
        language: client.recovery_template_lang || client.language || 'en',
        processed_params: { 1: leadName || 'there' },
      },
    }),
  });
  if (!r.ok) throw new Error(`Chatwoot template send failed → ${r.status}`);
  return r.json();
}

// ── VOICE FOLLOW-UPS (Sarvam AI TTS) ──────────────────────────────────────────
// Ported from engineSarvamTts/ENGINE_TTS_LANG_MAP/ENGINE_TTS_SPEAKER/engineExtractLinkPriceCaption
// in cloudflare-worker/worker.js — keep these in sync if the Worker's copy changes (speaker name,
// codec, sample rate). Template messages (sendTemplateMessage above) never go through here — voice
// notes aren't a WhatsApp template content type, so a lead outside the 24h session window always
// gets its approved text template regardless of this toggle.
const TTS_LANG_MAP = { en: 'en-IN', ml: 'ml-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN', bn: 'bn-IN', gu: 'gu-IN', mr: 'mr-IN', pa: 'pa-IN', or: 'od-IN' };
const TTS_SPEAKER = 'anushka'; // bulbul:v2's default female voice — see worker.js's ENGINE_TTS_SPEAKER comment

function extractLinkPriceCaption(text) {
  const links = [...new Set(text.match(/https?:\/\/\S+/g) || [])];
  const prices = [...new Set(text.match(/(?:AED|USD|INR|EUR|GBP|₹|\$|€|£)\s?[\d,]+(?:\.\d+)?/gi) || [])];
  const parts = [];
  if (prices.length) parts.push('💰 ' + prices.join(', '));
  if (links.length) parts.push('🔗 ' + links.join(' '));
  return parts.join('  ');
}

async function sarvamTts(text, targetLangCode) {
  if (!SARVAM_API_KEY || !text || !targetLangCode) return null;
  try {
    const r = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: { 'api-subscription-key': SARVAM_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 500), target_language_code: targetLangCode, speaker: TTS_SPEAKER, model: 'bulbul:v2', speech_sample_rate: 16000, output_audio_codec: 'opus' }),
    });
    if (!r.ok) { console.warn(`  [sarvamTts] HTTP ${r.status}`); return null; }
    const data = await r.json().catch(() => ({}));
    const b64 = data?.audios?.[0];
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    return buf.length >= 200 ? buf : null; // same "suspiciously small = failure" guard as worker.js
  } catch (e) {
    console.warn(`  [sarvamTts] threw: ${e.message}`);
    return null;
  }
}

// Returns true on a successful voice send, false on any failure (caller falls back to
// sendPlainMessage's normal text send) — never throws, since a voice hiccup should never cost a
// lead their follow-up entirely.
async function sendVoiceMessage(client, convId, text) {
  const bcp47 = TTS_LANG_MAP[(client.language || 'en').toLowerCase()];
  if (!bcp47) return false; // Sarvam TTS is Indic-language-focused, same scope limit as the live-reply pipeline
  const audioBuf = await sarvamTts(text, bcp47);
  if (!audioBuf) return false;
  try {
    const fd = new FormData();
    fd.append('content', extractLinkPriceCaption(text));
    fd.append('message_type', 'outgoing');
    fd.append('private', 'false');
    fd.append('attachments[]', new Blob([audioBuf], { type: 'audio/ogg; codecs=opus' }), 'followup.ogg');
    const url = `${client.chatwoot_base}/api/v1/accounts/${client.chatwoot_account_id}/conversations/${convId}/messages`;
    const r = await fetch(url, { method: 'POST', headers: { api_access_token: client.chatwoot_token }, body: fd });
    return r.ok;
  } catch (e) {
    console.warn(`  [sendVoiceMessage] threw: ${e.message}`);
    return false;
  }
}

// ── PROCESS ONE CLIENT ────────────────────────────────────────────────────────
async function processClient(client) {
  const tableId = client.leads_table_id || client.LEADS_TABLE_ID;
  if (!tableId) { console.log(`  [skip] no leads_table_id`); return; }
  if (!client.chatwoot_base || !client.chatwoot_account_id || !client.chatwoot_token) {
    console.log(`  [skip] missing chatwoot config`);
    return;
  }

  await ensureRecoveryFields(tableId, NOCODB_TOKEN);

  const leads = await fetchLeads(tableId, NOCODB_TOKEN);
  console.log(`  ${leads.length} candidate leads`);

  let sent = 0;
  for (const lead of leads) {
    let plan;
    try {
      plan = decide(lead, client);
    } catch (e) {
      console.warn(`  [decide error] lead ${lead.Id}: ${e.message}`);
      continue;
    }
    if (!plan) continue;

    const convId = getConvId(lead);
    const nextStage = plan.stage + 1;
    const now = new Date().toISOString();

    try {
      let sentText = plan.message;
      if (plan.templateName) {
        await sendTemplateMessage(client, convId, plan.templateName, lead.Name);
        sentText = `[template:${plan.templateName}]`;
      } else {
        sentText = await personalize(plan.message, lead, client);
        const sentViaVoice = truthy(client.voice_followup_enabled) && (await sendVoiceMessage(client, convId, sentText));
        if (!sentViaVoice) await sendPlainMessage(client, convId, sentText);
      }

      await ncPatch(`${NOCODB_BASE}/api/v2/tables/${tableId}/records`, {
        Id: lead.Id,
        recovery_stage: nextStage,
        recovery_done: nextStage >= parseCsvNums(client.recovery_gaps_hours, DEFAULT_GAPS_HOURS).length ? 'Yes' : 'No',
        recovery_last_sent_at: now,
        recovery_last_msg_snap: plan.lastRealMs,
        recovery_last_message: sentText,
      }, NOCODB_TOKEN);

      sent++;
      console.log(`  → sent stage ${plan.stage} recovery msg to lead ${lead.Id}`);
    } catch (e) {
      console.warn(`  [send error] lead ${lead.Id}: ${e.message}`);
    }

    await sleep(SEND_DELAY_MS);
  }

  console.log(`  Sent ${sent} recovery message(s)`);

  // Heartbeat for the Integrations tab health check — lets it tell "engine is running fine,
  // just nothing to send right now" apart from "engine has silently stopped running".
  try {
    await ncPatch(`${NOCODB_BASE}/api/v2/tables/${CLIENTS_TABLE}/records`, {
      Id: client.Id,
      recovery_heartbeat_at: new Date().toISOString(),
    }, NOCODB_TOKEN);
  } catch (e) {
    console.warn(`  [heartbeat error] ${e.message}`);
  }
}

// ── MAIN RUN ─────────────────────────────────────────────────────────────────
async function run() {
  const start = Date.now();
  console.log(`\n[Recovery] Run started at ${new Date().toISOString()}`);

  let clients = [];
  try {
    clients = await fetchClients();
  } catch (e) {
    console.error(`Failed to fetch clients: ${e.message}`);
    return;
  }

  console.log(`[Recovery] Processing ${clients.length} active clients`);

  for (const client of clients) {
    console.log(`\n→ Client: ${client.client_name || client.Id}`);
    try {
      await processClient(client);
    } catch (e) {
      console.error(`  Error: ${e.message}`);
    }
  }

  console.log(`\n[Recovery] Finished in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

// ── SCHEDULE: hourly at :20 (offset from nba.js's 00:05 daily run) ────────────
cron.schedule('20 * * * *', run, { timezone: 'UTC' });
console.log('[Recovery] Engine started — scheduled hourly at :20 UTC');

if (process.env.RUN_NOW === '1') {
  run().catch(console.error);
}
