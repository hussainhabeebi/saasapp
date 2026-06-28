import cron from 'node-cron';
import fetch from 'node-fetch';

// ── CONFIG ───────────────────────────────────────────────────────────────────
const NOCODB_BASE    = process.env.NOCODB_BASE    || 'https://whizz.aiingo.com';
const NOCODB_TOKEN   = process.env.NOCODB_TOKEN   || '';
const CLIENTS_TABLE  = process.env.CLIENTS_TABLE  || 'mxl33bg4wi70fqj';
const LEAD_DAYS      = 7;     // only process leads active within N days

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

// ── FIELD AUTO-CREATE ────────────────────────────────────────────────────────
const NBA_FIELDS = [
  { title: 'nba_action',   uidt: 'LongText' },
  { title: 'nba_priority', uidt: 'SingleLineText' },
  { title: 'nba_score',    uidt: 'Number' },
  { title: 'nba_at',       uidt: 'DateTime' },
];

async function ensureNbaFields(tableId, token) {
  try {
    const existing = await ncGet(`${NOCODB_BASE}/api/v2/meta/tables/${tableId}/fields`, token);
    const names = new Set((existing.list || []).map(f => f.title));
    for (const field of NBA_FIELDS) {
      if (!names.has(field.title)) {
        await ncPost(`${NOCODB_BASE}/api/v2/meta/tables/${tableId}/fields`, field, token);
        console.log(`  Created field "${field.title}" on table ${tableId}`);
      }
    }
  } catch (e) {
    console.warn(`  Could not ensure fields on ${tableId}: ${e.message}`);
  }
}

// ── FETCH LEADS ──────────────────────────────────────────────────────────────
async function fetchLeads(tableId, token) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LEAD_DAYS);
  const since = cutoff.toISOString().slice(0, 10);
  const TERMINAL = new Set(['Converted', 'Lost', 'Closed', 'Opt Out']);
  let all = [], page = 1;
  while (true) {
    const url = `${NOCODB_BASE}/api/v2/tables/${tableId}/records?limit=200&offset=${(page-1)*200}&sort=-Date`;
    const data = await ncGet(url, token);
    const rows = data.list || [];
    if (!rows.length) break;
    for (const r of rows) {
      if (TERMINAL.has(r.Stage)) continue;
      if (r.Date && r.Date < since) continue;
      all.push(r);
    }
    if (rows.length < 200) break;
    page++;
  }
  return all;
}

// ── RULE-BASED SCORING ───────────────────────────────────────────────────────
function daysSince(isoStr) {
  if (!isoStr) return 999;
  const d = new Date(isoStr);
  if (isNaN(d)) return 999;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function scoreLeads(leads) {
  return leads.map(lead => {
    let score = 0;
    const silent = daysSince(lead.LastMsgAt || lead.Date);

    // Recency (max 25)
    if (silent === 0)      score += 25;
    else if (silent <= 1)  score += 20;
    else if (silent <= 3)  score += 12;
    else if (silent <= 7)  score += 5;

    // Stage (max 30)
    const stageScores = { Hot: 30, Qualified: 22, 'In Progress': 18, New: 10, Cold: 2 };
    score += stageScores[lead.Stage] || 5;

    // Score field (max 15)
    const scoreMap = { Hot: 15, Warm: 10, Cold: 2 };
    score += scoreMap[lead.Score] || 0;

    // Qual answers complete (max 10)
    try {
      const qa = JSON.parse(lead.QualAnswers || '[]');
      if (Array.isArray(qa) && qa.length > 0) score += 10;
    } catch {}

    // Follow-up headroom (max 10)
    const fuCount  = parseInt(lead.followup_count || 3);
    const fuSent   = (lead.FollowupsSent || '').split(',').filter(Boolean).length;
    if (fuSent < fuCount) score += 10;

    // Booking time set (max 10)
    if (lead.BookingTime) score += 10;

    score = Math.min(100, score);

    let priority;
    if (score >= 70)      priority = 'critical';
    else if (score >= 50) priority = 'warm';
    else if (score >= 25) priority = 'nurture';
    else                  priority = 'cold';

    return { lead, score, priority, silent };
  });
}

// ── RULE-BASED NBA TEXT (no LLM) ────────────────────────────────────────────
function ruleNba(scored) {
  const { lead, priority, silent } = scored;
  const name = lead.Name || 'this lead';

  if (priority === 'cold') {
    return silent > 30
      ? `Archive or run a last-chance re-engagement message for ${name}.`
      : `Send a fresh angle message to ${name} — avoid repeating previous topics.`;
  }
  if (priority === 'nurture') {
    return `Keep ${name} warm with a value piece (tip, case study, or check-in). Don't push for a decision yet.`;
  }
  // warm
  const fuSent = (lead.FollowupsSent || '').split(',').filter(Boolean).length;
  if (fuSent === 0) return `Send first follow-up to ${name} within the next 2 hours while intent is fresh.`;
  if (silent <= 2)  return `${name} engaged recently — offer a quick call or next step to move them forward.`;
  return `Re-engage ${name} with a concrete offer or deadline to prompt a decision.`;
}

// ── META CAPI HOOK ───────────────────────────────────────────────────────────
const CAPI_WEBHOOK = process.env.CAPI_WEBHOOK || 'https://apps.leadvyne.com/webhook/leadvyne-capi';

async function fireCapiEvent(client, lead, score, priority) {
  if ((client.capi_enabled || 'No') !== 'Yes') return;
  if (!client.capi_pixel_id || !client.capi_token) return;
  // Only fire for warm+ leads (avoids spamming Meta with cold signals)
  if (priority === 'cold') return;
  try {
    await fetch(CAPI_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:  String(client.Id),
        lead_id:    String(lead.Id),
        phone:      lead.Phone || '',
        name:       lead.Name  || '',
        stage:      lead.Stage || '',
        nba_score:  score,
      }),
    });
  } catch (e) {
    console.warn(`  CAPI fire failed for lead ${lead.Id}: ${e.message}`);
  }
}

// ── BATCH PATCH ──────────────────────────────────────────────────────────────
async function patchLeads(tableId, updates, token) {
  // NocoDB accepts array PATCH for bulk update
  const CHUNK = 50;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await ncPatch(`${NOCODB_BASE}/api/v2/tables/${tableId}/records`, chunk, token);
  }
}

// ── PROCESS ONE CLIENT ────────────────────────────────────────────────────────
async function processClient(client) {
  const tableId = client.leads_table_id || client.LEADS_TABLE_ID;
  if (!tableId) { console.log(`  [skip] no leads_table_id`); return; }

  const token = NOCODB_TOKEN;
  console.log(`  Ensuring NBA fields…`);
  await ensureNbaFields(tableId, token);

  console.log(`  Fetching leads…`);
  const leads = await fetchLeads(tableId, token);
  console.log(`  ${leads.length} active leads`);
  if (!leads.length) return;

  const scored = scoreLeads(leads);
  console.log(`  Scoring ${scored.length} leads (rule-based)`);

  // Fire Meta CAPI events for warm/critical leads
  for (const s of scored) {
    if (s.priority === 'critical' || s.priority === 'warm') {
      await fireCapiEvent(client, s.lead, s.score, s.priority);
    }
  }

  const now = new Date().toISOString();
  const updates = scored.map(s => ({
    Id: s.lead.Id,
    nba_action:   ruleNba(s),
    nba_priority: s.priority,
    nba_score:    s.score,
    nba_at:       now,
  }));

  console.log(`  Patching ${updates.length} records…`);
  await patchLeads(tableId, updates, token);
  console.log(`  Done ✓`);
}

// ── MAIN RUN ─────────────────────────────────────────────────────────────────
async function run() {
  const start = Date.now();
  console.log(`\n[NBA] Run started at ${new Date().toISOString()}`);

  // Fetch all client records
  let clients = [];
  try {
    const data = await ncGet(
      `${NOCODB_BASE}/api/v2/tables/${CLIENTS_TABLE}/records?limit=200`,
      NOCODB_TOKEN
    );
    clients = (data.list || []).filter(c => c.active === 'Yes' || c.active === true);
  } catch (e) {
    console.error(`Failed to fetch clients: ${e.message}`);
    return;
  }

  console.log(`[NBA] Processing ${clients.length} active clients`);

  for (const client of clients) {
    console.log(`\n→ Client: ${client.client_name || client.Id}`);
    try {
      await processClient(client);
    } catch (e) {
      console.error(`  Error: ${e.message}`);
    }
  }

  console.log(`\n[NBA] Finished in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

// ── SCHEDULE: 00:05 AM daily ──────────────────────────────────────────────────
cron.schedule('5 0 * * *', run, { timezone: 'UTC' });
console.log('[NBA] Engine started — scheduled at 00:05 UTC daily');

// Run immediately on start if env flag set (useful for testing)
if (process.env.RUN_NOW === '1') {
  run().catch(console.error);
}
