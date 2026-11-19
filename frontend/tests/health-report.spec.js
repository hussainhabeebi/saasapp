// Settings → Integrations → 🩺 Health Check: the daily health report (health-report-ui.js).
// Hermetic file:// setup as dest-routing.spec.js — the Worker's /health/* routes are faked here.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

const res = (key, label, category, status, detail, extra = {}) => ({ key, label, category, status, detail, ...extra });
const REPORT = {
  id: 12, ts: '2026-11-19T02:00:00.000Z', trigger: 'daily', status: 'fail', label: 'Critical', last_healthy_at: '2026-11-15T02:00:00.000Z',
  totals: { total: 5, passed: 2, failed: 1, warnings: 1, not_tested: 1 },
  results: [
    res('whatsapp', 'WhatsApp (Meta)', 'integration', 'ok', '+971 50 000 0000', { last_ok_at: '2026-11-19T02:00:00.000Z' }),
    res('webhooks', 'Webhook Connections', 'integration', 'fail', 'No Chatwoot webhook delivers messages to the bot', { change: 'recurring', streak: 3, last_ok_at: '2026-11-16T02:00:00.000Z', hint: 'Reconnect Chatwoot in Settings → Channels.' }),
    res('crm_contacts', 'Contact Management', 'crm', 'warn', '2 have no phone or email', { change: 'new', streak: 1, hint: 'Fill them in.' }),
    res('db_write', 'Data Saving', 'database', 'ok', 'Test record saved and read back', { change: 'fixed' }),
    res('n8n_workflows', 'n8n Workflow Executions', 'automation', 'off', 'Not used — messages are handled by the built-in engine'),
  ],
  recommendations: [
    { key: 'webhooks', label: 'Webhook Connections', severity: 'error', problem: 'No Chatwoot webhook delivers messages to the bot', action: 'Reconnect Chatwoot in Settings → Channels.', change: 'recurring', streak: 3 },
    { key: 'crm_contacts', label: 'Contact Management', severity: 'warning', problem: '2 have no phone or email', action: 'Fill them in.', change: 'new', streak: 1 },
  ],
  fixed: [{ key: 'db_write', label: 'Data Saving', was: 'fail' }],
};
const OLDER = { ...REPORT, id: 11, ts: '2026-11-18T02:00:00.000Z', status: 'warn', label: 'Needs Attention', fixed: [], totals: { total: 5, passed: 3, failed: 0, warnings: 1, not_tested: 1 } };

async function boot(page, { reports = [OLDER, REPORT] } = {}) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (!url.startsWith(WORKER)) return route.abort();
    const p = new URL(url).pathname;
    calls.push(`${req.method()} ${p}`);
    if (p === '/health/reports') return route.fulfill({ json: { ok: true, latest: reports.at(-1) || null,
      reports: [...reports].reverse().map((r) => ({ id: r.id, ts: r.ts, trigger: r.trigger, status: r.status, label: r.label, totals: r.totals, fixed: r.fixed })),
      recurring: reports.length ? [{ key: 'webhooks', label: 'Webhook Connections', count: 3, errors: 3, open: true, runs: 3 }] : [] } });
    if (p === '/health/reports/11') return route.fulfill({ json: { ok: true, report: OLDER } });
    if (p === '/health/run') return route.fulfill({ json: { ok: true, status: 'ok', checked_at: '2026-11-19T09:00:00.000Z', results: [], report: { ...REPORT, id: 13, status: 'ok', label: 'Healthy', recommendations: [], fixed: [], totals: { total: 1, passed: 1, failed: 0, warnings: 0, not_tested: 0 }, results: [res('whatsapp', 'WhatsApp (Meta)', 'integration', 'ok', 'ok')] } } });
    return route.fulfill({ json: {} });
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageIntegrations').classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = { Id: 7, client_name: 'Acme Tours' }; sessionToken = 't';
    window.renderHealthResults();
  });
  return calls;
}

test('shows overall status, totals, recommended actions, categories, history and recurring issues', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#intHealthBadge')).toHaveText('Critical');
  const list = page.locator('#intHealthList');
  await expect(list).toContainText('Total tests5');
  await expect(list).toContainText('Failed1');
  await expect(list).toContainText('Not tested1');
  await expect(list).toContainText('Recommended actions');
  await expect(list).toContainText('→ Reconnect Chatwoot in Settings → Channels.');
  await expect(list).toContainText('Recurring · 3 runs');
  await expect(list).toContainText('Fixed since the previous check: Data Saving');
  for (const cat of ['Integration Health', 'CRM Functionality', 'Automation Health', 'Database Health']) await expect(list).toContainText(cat);
  await expect(list).toContainText('Last successful:');
  await expect(page.locator('#intHealthLastChecked')).toContainText('Last fully healthy');
  const hist = page.locator('#intHealthHistory');
  await expect(hist).toContainText('Recurring issues');
  await expect(hist).toContainText('Webhook Connections — a problem in 3 of 3 checks (3 as an error) · still open');
  await expect(hist.locator('[data-health-report]')).toHaveCount(2);
  // Open an older report from history.
  await hist.locator('[data-health-report="11"]').click();
  await expect(page.locator('#intHealthBadge')).toHaveText('Needs Attention');
});

test('Run Check Now shows the new report; Download PDF builds the report file', async ({ page }) => {
  const calls = await boot(page);
  await page.evaluate(() => {
    // Recording stand-in for jsPDF (the CDN is blocked in these tests).
    const log = window.__pdf = { text: [], tables: [], saved: null };
    function D() { this.internal = { pageSize: { getWidth: () => 595, getHeight: () => 842 }, getNumberOfPages: () => 1 }; this.lastAutoTable = { finalY: 100 }; }
    for (const m of ['setFont', 'setFontSize', 'setTextColor', 'addPage', 'setPage']) D.prototype[m] = function () {};
    D.prototype.text = function (t) { log.text.push([].concat(t).join(' ')); };
    D.prototype.splitTextToSize = (t) => [t];
    D.prototype.autoTable = function (o) { log.tables.push({ head: o.head, body: o.body }); };
    D.prototype.save = (name) => { log.saved = name; };
    window.jspdf = { jsPDF: D };
  });
  await expect(page.locator('#intHealthPdfBtn')).toBeEnabled();
  await page.locator('#intHealthPdfBtn').click();
  const pdf = await page.evaluate(() => window.__pdf);
  expect(pdf.saved).toBe('health-report-Acme-Tours-2026-11-19.pdf');
  expect(pdf.text).toContain('Overall status: Critical');
  expect(pdf.tables[0].body[0]).toEqual([5, 2, 1, 1, 1]);
  expect(pdf.tables[1].head[0]).toEqual(['Severity', 'Check', 'Problem', 'Recommended action']);
  expect(pdf.tables[1].body[0][3]).toBe('Reconnect Chatwoot in Settings > Channels.');
  expect(pdf.tables.at(-1).body[0]).toEqual(['Webhook Connections', '3 of 3 checks', 3, 'Still open']);

  await page.locator('#intHealthRunBtn').click();
  await expect(page.locator('#intHealthMsg')).toHaveText('✓ Done');
  expect(calls).toContain('POST /health/run');
});

test('never checked: says so and the PDF button stays disabled', async ({ page }) => {
  await boot(page, { reports: [] });
  await expect(page.locator('#intHealthBadge')).toHaveText('Not checked yet');
  await expect(page.locator('#intHealthPdfBtn')).toBeDisabled();
  await expect(page.locator('#intHealthHistory')).toContainText('History starts with the next check.');
});
