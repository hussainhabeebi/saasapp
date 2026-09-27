// Baby Care product summary follow-up: one recap ~30 min after a customer asked about a product
// and went quiet (Ecom → Settings, opt-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { babyCareSummaryDue, babyCareSummaryFallback, runBabyCareSummaryFollowupsForAllClients } from './worker.js';

const NOW = Date.parse('2026-09-27T10:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const botLast = JSON.stringify([{ role: 'user', content: 'price?' }, { role: 'assistant', content: '₹999' }]);
const lead = (o = {}) => ({ 'Last Product Sku': 'AFR1', Stage: 'new', LastCustomerMsgAt: ago(35), ConvHistory: botLast, ...o });

test('due once the customer asked about a product and has been quiet 30+ minutes', () => {
  assert.equal(babyCareSummaryDue(lead(), NOW), true);
});

test('not due in every case where a recap would be wrong or annoying', () => {
  const cases = {
    'too soon': lead({ LastCustomerMsgAt: ago(20) }),
    'outside WhatsApp 24h window': lead({ LastCustomerMsgAt: ago(24 * 60) }),
    'no product asked about': lead({ 'Last Product Sku': '' }),
    'customer spoke last': lead({ ConvHistory: JSON.stringify([{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'ok' }]) }),
    'staff replied after the customer': lead({ LastAgentMsgAt: ago(10) }),
    'handed over': lead({ Handover: 'Yes' }),
    'opted out': lead({ OptOut: 'Yes' }),
    'already sent after this message': lead({ ProductSummarySentAt: ago(5) }),
    'sent within the last 24h': lead({ LastCustomerMsgAt: ago(40), ProductSummarySentAt: ago(60 * 5) }),
    'won / converted': lead({ Stage: 'won' }),
  };
  for (const [why, l] of Object.entries(cases)) assert.equal(babyCareSummaryDue(l, NOW), false, why);
  // custom delay
  assert.equal(babyCareSummaryDue(lead({ LastCustomerMsgAt: ago(50) }), NOW, 60), false);
  assert.equal(babyCareSummaryDue(lead({ LastCustomerMsgAt: ago(65) }), NOW, 60), true);
});

test('fallback recap names the product, price and what the customer told us', () => {
  const t = babyCareSummaryFallback({ name: 'Affordable Full Romper Set', price: 999, currency: 'INR' },
    { details: { customisation: 'Name: Ayra' } });
  assert.match(t, /Affordable Full Romper Set.*₹999/);
  assert.match(t, /Name: Ayra/);
});

test('sweep: sends the recap with Order/Talk buttons, claims it once, appends to history', async () => {
  const realFetch = globalThis.fetch;
  const patches = []; const chatwootSends = [];
  const quiet = new Date(Date.now() - 35 * 60000).toISOString();
  const client = { Id: 48, client_name: 'Couplo', industry: 'ecommerce', chatwoot_base: 'https://cw.test', chatwoot_account_id: 1, chatwoot_token: 't',
    bot_config: JSON.stringify({ ecom_communication_style: 'baby_care', baby_care_summary_followup_enabled: true, followup_quiet_hours_enabled: false }) };
  const leadRow = { Id: 5, Phone: '919000000000', Stage: 'new', ConversationID: 77, 'Last Product Sku': 'AFR1', LastCustomerMsgAt: quiet, LastMsgAt: quiet, ConvHistory: botLast };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/meta/')) return new Response(JSON.stringify({ list: [{ title: 'ProductSummarySentAt' }, { title: 'LastCustomerMsgAt' }] }));
    if (u.includes('cw.test')) { chatwootSends.push(opts.body instanceof FormData ? Object.fromEntries(opts.body) : JSON.parse(opts.body || '{}')); return new Response('{}'); }
    if ((opts.method || 'GET') === 'PATCH') { patches.push(JSON.parse(opts.body)); return new Response('{}'); }
    if (u.includes('ecom_table_ids') || u.includes('/records/48')) return new Response(JSON.stringify(client));
    if (u.includes('where=') && u.includes('AFR1')) return new Response(JSON.stringify({ list: [{ Id: 9, sku: 'AFR1', name: 'Affordable Full Romper Set', price: 999, currency: 'INR', client_id: '48' }] }));
    if (u.includes('ClientId%2Ceq%2C48')) return new Response(JSON.stringify({ list: [leadRow] }));
    if (u.includes('records?limit=200')) return new Response(JSON.stringify({ list: [client] }));
    return new Response(JSON.stringify({ list: [] }));
  };
  try {
    await runBabyCareSummaryFollowupsForAllClients({ NOCODB_BASE: 'http://nc.test', NOCODB_TOKEN: 'x' });
  } finally { globalThis.fetch = realFetch; }
  assert.ok(patches.some((p) => p.Id === 5 && p.ProductSummarySentAt), 'claimed before sending');
  assert.ok(chatwootSends.some((b) => /Affordable Full Romper Set/.test(JSON.stringify(b))), 'recap sent to the conversation');
  assert.ok(chatwootSends.some((b) => /Order this/.test(JSON.stringify(b))), 'Order this button offered');
  const histPatch = patches.find((p) => p.ConvHistory);
  assert.ok(histPatch && /CHAT_ORDER_START/.test(histPatch.ConvHistory), 'history keeps the button values for tap resolution');
});
