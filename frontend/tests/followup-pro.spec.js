// Follow-up V3 Pro add-ons in the browser (followup-pro-ui.js + followup-status.js): the Home
// "Who to contact now" card, the Pro lines on the lead's Follow-up card, and the 📄 Quote builder.
// Hermetic: a blank page with the two scripts, every Worker call answered by the route stub below.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const W = 'https://worker.test';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Expose-Headers': 'X-Quote-No' };

async function setup(page, handler) {
  const calls = [];
  await page.route(W + '/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push({ url: req.url(), method: req.method(), body });
    const r = await handler(req.url(), body);
    return route.fulfill({ status: r.status || 200, headers: { ...CORS, 'Content-Type': r.type || 'application/json', ...(r.headers || {}) }, body: r.raw ?? JSON.stringify(r.json) });
  });
  await page.setContent('<!doctype html><html><body><div id="home" style="display:none"></div><div id="card"></div></body></html>');
  await page.addScriptTag({ path: path.resolve(__dirname, '../followup-status.js') });
  await page.addScriptTag({ path: path.resolve(__dirname, '../followup-pro-ui.js') });
  return calls;
}

test('Home card stays hidden until the add-on is on', async ({ page }) => {
  await setup(page, () => ({ json: { enabled: false } }));
  await page.evaluate((w) => FollowupPro.renderHome(document.getElementById('home'), w, 'tok', { force: true }), W);
  await expect(page.locator('#home')).toBeHidden();
});

test('Home card lists who to contact, with the action, and opens the lead', async ({ page }) => {
  await setup(page, () => ({ json: { enabled: true, counts: { critical: 1, warm: 0, nurture: 0, cold: 1 }, list: [
    { lead_id: 11, name: 'Asha', stage: 'quotation_sent', score: 84, band: 'critical', action: "Reply now — they're waiting for your team (WhatsApp window closes in 20h)", reasons: ['wrote today', 'objection: price'] },
    { lead_id: 12, name: 'Ravi', stage: 'new', score: 8, band: 'cold', action: 'Let follow-ups re-engage, or try a call', reasons: [] },
  ] } }));
  await page.evaluate((w) => { window.opened = []; window.openLeadFromAlert = (id) => window.opened.push(id); return FollowupPro.renderHome(document.getElementById('home'), w, 'tok', { force: true }); }, W);
  const home = page.locator('#home');
  await expect(home).toBeVisible();
  await expect(home).toContainText('Who to contact now');
  await expect(home).toContainText('⚡ Critical 1');
  await expect(home).toContainText('Reply now');
  await expect(home).toContainText('objection: price');
  await home.getByRole('button', { name: /Asha/ }).click();
  expect(await page.evaluate(() => window.opened)).toEqual([11]);
});

test('lead card shows only the Pro lines the account has on, plus the Quote button', async ({ page }) => {
  await setup(page, () => ({ json: {} }));
  const base = { enabled: true, status: 'scheduled', steps: [], history: [], next: null, text: '' };
  let html = await page.evaluate((d) => FollowupStatus.html(d, { onQuote: 'openQ', leadId: 7 }), { ...base, pro: {} });
  expect(html).not.toContain('Quote PDF');
  html = await page.evaluate((d) => FollowupStatus.html(d, { onQuote: 'openQ', leadId: 7 }), { ...base, pro: {
    language_name: 'Malayalam', objection: 'price', snooze_until: new Date(Date.now() + 86400e3).toISOString(),
    nba: { score: 61, band: 'warm', action: 'Send the quote with a budget option or part-payment', reasons: [] },
    quote_pdf: true, last_quote: { quote_no: 'Q-20261113-00007', total: 24000, currency: 'INR', via: 'followup', created_at: new Date().toISOString() },
  } });
  await page.evaluate((h) => { document.getElementById('card').innerHTML = h; }, html);
  const card = page.locator('#card');
  await expect(card).toContainText('🌐 Malayalam');
  await expect(card).toContainText('🧱 price');
  await expect(card).toContainText('⏰ until');
  await expect(card).toContainText('🔥 61 · Warm');
  await expect(card).toContainText('Q-20261113-00007');
  await expect(card).toContainText('(auto)');
  await expect(card.getByRole('button', { name: '📄 Quote PDF' })).toBeVisible();
});

test('Quote builder: lead\'s choice pre-picked, extra line, discount, send', async ({ page }) => {
  const calls = await setup(page, (url, body) => {
    if (url.includes('/quote/catalog')) return { json: {
      catalog: [
        { key: 'p1', name: 'Kerala Houseboat 2N', price: 12000, currency: 'INR', image: '' },
        { key: 'p2', name: 'Goa Beach 4N', price: 21000, currency: 'INR', image: '' },
      ], suggested: ['p1'], window_open: true, lead: { id: 7, name: 'Asha K', interested: 'houseboat' }, valid_days: 7, note: '30% advance', currency: 'INR' } };
    if (url.endsWith('/quote') && body && !body.send) return { raw: '%PDF-1.4\n%%EOF\n', type: 'application/pdf', headers: { 'X-Quote-No': 'Q-1' } };
    if (url.endsWith('/quote')) return { json: { ok: true, sent: true, quote_no: 'Q-20261113-00007', total: 25500 } };
    return { status: 404, json: {} };
  });
  await page.evaluate((w) => { window.sent = null; FollowupPro.openQuote(w, 'tok', 7, { onSent: (r) => { window.sent = r; } }); }, W);
  const modal = page.locator('#fpQuoteModal');
  await expect(modal).toContainText('Quote for Asha K');
  await expect(modal).toContainText("lead's choice");
  await expect(modal.locator('[data-key="p1"]')).toBeChecked();
  await expect(modal.locator('[data-key="p2"]')).not.toBeChecked();
  await modal.locator('[data-qty="p1"]').fill('2');
  await modal.getByRole('button', { name: /Add a line/ }).click();
  await modal.locator('[data-f="name"]').fill('Airport transfer');
  await modal.locator('[data-f="price"]').fill('1500');
  await modal.locator('[data-discount]').fill('0');
  await expect(modal.locator('[data-total]')).toContainText('INR 25,500');
  // Search filters the list.
  await modal.locator('[data-search]').fill('goa');
  await expect(modal.locator('[data-list] > label').first()).toBeHidden();
  await modal.locator('[data-search]').fill('');
  await modal.getByRole('button', { name: /Send on WhatsApp/ }).click();
  await expect(modal).toContainText('Sent ✓ Q-20261113-00007');
  const post = calls.find((c) => c.method === 'POST' && c.body.send);
  expect(post.body).toMatchObject({ lead_id: 7, items: [{ key: 'p1', qty: 2 }, { name: 'Airport transfer', price: 1500, qty: 1 }], discount: 0, valid_days: 7, note: '30% advance', send: true });
  expect(post.url).toBe(W + '/followups/v3/quote');
  await expect.poll(() => page.evaluate(() => window.sent && window.sent.quote_no)).toBe('Q-20261113-00007');
  await expect(modal).toBeHidden();
});

test('Quote builder: closed WhatsApp window disables sending; switched-off add-on explains why', async ({ page }) => {
  let off = false;
  await setup(page, () => off
    ? { status: 400, json: { error: 'Turn on "Quote PDF in one tap" in Follow-ups → Settings → Pro add-ons first.' } }
    : { json: { catalog: [{ key: 'p1', name: 'Item', price: 10, currency: 'INR' }], suggested: [], window_open: false, lead: { id: 7, name: 'Asha' }, valid_days: 7, currency: 'INR' } });
  await page.evaluate((w) => FollowupPro.openQuote(w, 'tok', 7), W);
  const modal = page.locator('#fpQuoteModal');
  await expect(modal).toContainText('24-hour WhatsApp window is closed');
  await expect(modal.getByRole('button', { name: /Send on WhatsApp/ })).toBeDisabled();
  await expect(modal.locator('[data-total]')).toContainText('Pick at least one product');
  off = true;
  await page.evaluate((w) => FollowupPro.openQuote(w, 'tok', 7), W);
  await expect(modal).toContainText('Pro add-ons first');
});
