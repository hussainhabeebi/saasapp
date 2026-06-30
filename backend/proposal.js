import cron from 'node-cron';
import fetch from 'node-fetch';
import PDFDocument from 'pdfkit';

// ── CONFIG ───────────────────────────────────────────────────────────────────
const NOCODB_BASE   = process.env.NOCODB_BASE   || 'https://whizz.aiingo.com';
const NOCODB_TOKEN  = process.env.NOCODB_TOKEN  || '';
const CLIENTS_TABLE = process.env.CLIENTS_TABLE || 'mxl33bg4wi70fqj';
const POLL_LOOKBACK_MIN = 180; // only scan conversations active within this window

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
  return all.filter(c => (c.active || 'Yes') === 'Yes' && (c.proposal_enabled || 'No') === 'Yes'
    && c.chatwoot_base && c.chatwoot_account_id && c.chatwoot_token);
}

async function cwGet(client, path) {
  const r = await fetch(`${client.chatwoot_base.replace(/\/$/, '')}${path}`, {
    headers: { api_access_token: client.chatwoot_token },
  });
  if (!r.ok) throw new Error(`Chatwoot GET ${path} → ${r.status}`);
  return r.json();
}

async function cwSendPdf(client, convId, buf, filename, caption) {
  const form = new FormData();
  form.append('message_type', 'outgoing');
  form.append('private', 'false');
  form.append('content', caption || '');
  form.append('attachments[]', new Blob([buf], { type: 'application/pdf' }), filename);

  const r = await fetch(`${client.chatwoot_base.replace(/\/$/, '')}/api/v1/accounts/${client.chatwoot_account_id}/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { api_access_token: client.chatwoot_token },
    body: form,
  });
  if (!r.ok) throw new Error(`Chatwoot send PDF → ${r.status}`);
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

// ── PRICE DETECTION ──────────────────────────────────────────────────────────
// Cheap pre-filter so we only spend an LLM call on messages that plausibly contain a price.
const PRICE_HINT_RE = /(?:[$€£₹]|aed|usd|gbp|eur|sar|inr)\s?\d|\d[\d,.]*\s?(?:\$|usd|aed|sar|inr|dollars?|dirhams?|rs\.?)/i;

function lastOutgoing(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant' || history[i].role === 'bot') return history[i];
  }
  return null;
}

function lastIncomingAfter(history, ts) {
  // does the customer keep engaging after the price was quoted (not a flat close-out)?
  const idx = history.findIndex(m => m.ts === ts);
  if (idx === -1) return true; // can't tell, default to allow
  const after = history.slice(idx + 1).filter(m => m.role === 'user' || m.role === 'contact');
  if (!after.length) return false; // bot quoted, customer hasn't replied again yet — wait
  const lastReply = (after[after.length - 1].content || '').toLowerCase().trim();
  const closeOut = /^(ok|okay|thanks|thank you|noted|got it|cool|alright)\.?!?$/.test(lastReply);
  return !closeOut;
}

async function extractQuoteFromText(client, botText) {
  const orKey = client.openrouter_key || '';
  const model = client.model || 'google/gemini-2.5-flash';
  if (!orKey) return null;

  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 300, temperature: 0,
        messages: [
          { role: 'system', content: 'You extract pricing info that a sales assistant already stated to a customer. Return ONLY strict JSON, no markdown, no explanation. Schema: {"has_price": boolean, "currency": string, "items": [{"name": string, "qty": number, "unit_price": number}], "total": number}. If no clear priced item is present, return {"has_price": false}.' },
          { role: 'user', content: botText },
        ],
      }),
    });
    const data = await r.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || '';
    const cleaned = raw.replace(/^```json\s*|```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.has_price || !Array.isArray(parsed.items) || !parsed.items.length) return null;
    return parsed;
  } catch (e) {
    console.warn('  quote extraction failed:', e.message);
    return null;
  }
}

// ── PDF GENERATION ───────────────────────────────────────────────────────────
// Fixed template — layout, colors, sections and copy never change between quotes.
// The only variable content per quote is: client branding (name), customer name,
// the line items, and the computed total. Everything else is structural.
const BRAND_COLOR = '#1A73E8';
const PAGE_LEFT = 50, PAGE_RIGHT = 545;
const COL_ITEM = 50, COL_QTY = 330, COL_PRICE = 400, COL_TOTAL = 475;

function quoteNumber(convId) {
  const d = new Date();
  return `Q-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${convId}`;
}

function buildQuotePdf(client, contactName, quote, convId) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header band ──
    doc.rect(0, 0, doc.page.width, 90).fill(BRAND_COLOR);
    doc.fillColor('#fff').fontSize(20).text(client.client_name || 'Quotation', PAGE_LEFT, 32, { width: 300 });
    doc.fontSize(10).text('OFFICIAL QUOTATION', PAGE_LEFT, 58);
    doc.fontSize(10).text(`No: ${quoteNumber(convId)}`, 350, 32, { width: 195, align: 'right' });
    doc.text(`Date: ${new Date().toLocaleDateString()}`, 350, 48, { width: 195, align: 'right' });
    doc.fillColor('#000');

    // ── Customer block ──
    doc.moveTo(PAGE_LEFT, 110).fontSize(9).fillColor('#888').text('PREPARED FOR', PAGE_LEFT, 110);
    doc.fontSize(12).fillColor('#000').text(contactName || 'Valued Customer', PAGE_LEFT, 124);
    doc.moveDown(1.5);

    // ── Table header ──
    let y = 165;
    doc.rect(PAGE_LEFT, y, PAGE_RIGHT - PAGE_LEFT, 22).fill('#F2F4F7');
    doc.fillColor('#444').fontSize(10);
    doc.text('Item', COL_ITEM + 8, y + 6);
    doc.text('Qty', COL_QTY, y + 6);
    doc.text('Unit', COL_PRICE, y + 6);
    doc.text('Total', COL_TOTAL, y + 6);
    y += 30;

    const currency = quote.currency || '';
    let computedTotal = 0;
    doc.fillColor('#000').fontSize(10);
    (quote.items || []).forEach((it, i) => {
      const qty = Number(it.qty) || 1;
      const unit = Number(it.unit_price) || 0;
      const lineTotal = qty * unit;
      computedTotal += lineTotal;
      if (i % 2 === 1) doc.rect(PAGE_LEFT, y - 4, PAGE_RIGHT - PAGE_LEFT, 22).fill('#FAFAFA').fillColor('#000');
      doc.text(String(it.name || 'Item'), COL_ITEM + 8, y, { width: 260 });
      doc.text(String(qty), COL_QTY, y);
      doc.text(`${currency} ${unit.toFixed(2)}`, COL_PRICE, y);
      doc.text(`${currency} ${lineTotal.toFixed(2)}`, COL_TOTAL, y);
      y += 24;
    });

    doc.moveTo(PAGE_LEFT, y + 4).lineTo(PAGE_RIGHT, y + 4).strokeColor('#ddd').stroke();
    y += 16;
    const total = Number(quote.total) || computedTotal;
    doc.fontSize(12).fillColor(BRAND_COLOR).text(`Total: ${currency} ${total.toFixed(2)}`, COL_ITEM, y, { width: PAGE_RIGHT - PAGE_LEFT, align: 'right' });
    doc.fillColor('#000');

    // ── Fixed footer ──
    const footerY = doc.page.height - 110;
    doc.moveTo(PAGE_LEFT, footerY).lineTo(PAGE_RIGHT, footerY).strokeColor('#ddd').stroke();
    doc.fontSize(8).fillColor('#888').text(
      'This quotation was generated based on pricing discussed in your conversation and is valid for 7 days from the date above. Final pricing subject to confirmation.',
      PAGE_LEFT, footerY + 10, { width: PAGE_RIGHT - PAGE_LEFT }
    );
    doc.text(`${client.client_name || ''}`, PAGE_LEFT, footerY + 40);

    doc.end();
  });
}

// ── PER-CLIENT PASS ──────────────────────────────────────────────────────────
async function processClient(client) {
  const cutoff = new Date(Date.now() - POLL_LOOKBACK_MIN * 60 * 1000);

  let convos;
  try {
    const data = await cwGet(client, `/api/v1/accounts/${client.chatwoot_account_id}/conversations?status=all`);
    convos = data.data?.payload || data.payload || [];
  } catch (e) {
    console.warn(`  [${client.client_name}] conversation fetch failed: ${e.message}`);
    return;
  }

  for (const conv of convos) {
    const lastActivity = new Date((conv.last_activity_at || conv.timestamp || 0) * 1000);
    if (lastActivity < cutoff) continue;

    const attrs = conv.custom_attributes || {};
    if (attrs.proposal_sent_at) continue;

    let history;
    try {
      const msgsData = await cwGet(client, `/api/v1/accounts/${client.chatwoot_account_id}/conversations/${conv.id}/messages`);
      const raw = msgsData.payload || [];
      history = raw.map(m => ({
        role: m.message_type === 1 ? 'assistant' : 'user',
        content: m.content || '',
        ts: new Date((m.created_at || 0) * 1000).toISOString(),
      }));
    } catch (e) {
      console.warn(`  [${client.client_name}] conv ${conv.id} message fetch failed: ${e.message}`);
      continue;
    }

    const lastBotMsg = lastOutgoing(history);
    if (!lastBotMsg || !PRICE_HINT_RE.test(lastBotMsg.content || '')) continue;
    if (!lastIncomingAfter(history, lastBotMsg.ts)) continue; // customer closed out, don't quote

    try {
      const quote = await extractQuoteFromText(client, lastBotMsg.content);
      if (!quote) continue;

      const sender = conv.meta?.sender || {};
      const contactName = sender.name || '';
      const pdfBuf = await buildQuotePdf(client, contactName, quote, conv.id);
      const filename = `quotation-${conv.id}.pdf`;

      await cwSendPdf(client, conv.id, pdfBuf, filename, 'Here is your official quotation 📄');
      await cwSetCustomAttrs(client, conv.id, { proposal_sent_at: new Date().toISOString() });
      await ncPatch(`${NOCODB_BASE}/api/v2/tables/${CLIENTS_TABLE}/records/${client.Id}`, {
        proposal_stat_sent: (parseInt(client.proposal_stat_sent || 0) + 1),
      });
      console.log(`  [${client.client_name}] sent PDF quotation → conv ${conv.id}`);
    } catch (e) {
      console.warn(`  [${client.client_name}] conv ${conv.id} failed: ${e.message}`);
    }
  }
}

// ── MAIN LOOP ────────────────────────────────────────────────────────────────
async function runOnce() {
  console.log(`\n[proposal] poll @ ${new Date().toISOString()}`);
  if (!NOCODB_TOKEN) { console.error('NOCODB_TOKEN not set'); return; }

  const clients = await fetchActiveClients();
  console.log(`  ${clients.length} client(s) with proposal module enabled`);
  for (const client of clients) {
    await processClient(client).catch(e => console.warn(`  [${client.client_name}] error: ${e.message}`));
  }
}

if (process.env.RUN_NOW === '1') {
  runOnce().then(() => process.exit(0));
} else {
  cron.schedule('*/2 * * * *', runOnce); // every 2 minutes
  console.log('[proposal] poller started — running every 2 minutes');
  runOnce();
}
