// Human Deals → "Release back to bot" (dashboard.html applyHumanDealOutcome / botReentryStage).
// The released lead must land on a stage the engine won't immediately hand back to a human — the
// engine escalates any positive reply on the flow's LAST stage — and must not keep a stale
// HandoverBy from a Chats "Take over". Same hermetic file:// setup as lead-actions.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

async function release(page, stages, lead = {}) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  return page.evaluate(async ({ stages, lead }) => {
    // @ts-ignore
    window.__patches = [];
    // @ts-ignore
    window.ncPatch = async (_url, body) => { window.__patches.push(body); };
    // @ts-ignore
    window.reportLeadQualityChange = () => {};
    const flowStages = Object.fromEntries(stages.map((s) => [s, { message: s }]));
    // @ts-ignore
    clientRecord = { flow_json: JSON.stringify({ stages: flowStages }) };
    // @ts-ignore
    allLeads = [{ Id: 7, Name: 'Sara', Phone: '971500000007', Stage: 'human_handover', Handover: 'Yes',
      HandoverAt: new Date(Date.now() - 600000).toISOString(), ...lead }];
    // @ts-ignore
    await applyHumanDealOutcome(7, 'Released');
    // @ts-ignore
    return { patch: window.__patches[0], lead: allLeads[0] };
  }, { stages, lead });
}

test('2-stage flow: released lead goes to Stage 1, not the last stage that re-escalates', async ({ page }) => {
  const { patch } = await release(page, ['new', 'stage_1', 'stage_2']);
  expect(patch.Stage).toBe('stage_1');
  expect(patch.Handover).toBe('No');
});

test('3+ stage flow: released lead goes to Stage 2', async ({ page }) => {
  const { patch } = await release(page, ['new', 'stage_1', 'stage_2', 'stage_3']);
  expect(patch.Stage).toBe('stage_2');
});

test('no flow configured: falls back to new', async ({ page }) => {
  const { patch } = await release(page, []);
  expect(patch.Stage).toBe('new');
});

test('released lead leaves the Human Deals queue', async ({ page }) => {
  await release(page, ['new', 'stage_1', 'stage_2']);
  // @ts-ignore
  expect(await page.evaluate(() => humanDealsQueue().length)).toBe(0);
});

test('clears a Chats takeover marker so a later bot handover is not mistaken for one', async ({ page }) => {
  const { patch } = await release(page, ['new', 'stage_1', 'stage_2'], { HandoverBy: 'rep@example.com' });
  expect(patch.HandoverBy).toBe('');
});

test('does not send HandoverBy when the column does not exist yet', async ({ page }) => {
  const { patch } = await release(page, ['new', 'stage_1', 'stage_2']);
  expect('HandoverBy' in patch).toBe(false);
});
