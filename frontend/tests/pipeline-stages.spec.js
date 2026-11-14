// Default + customisable lead pipeline stages (dashboard.html pipelineStageIds / pipelineBoardStages /
// openPipelineStagesEditor). Every industry gets default stages except Travel (uses the 📌 Status
// Board) and General (no defaults, but can add its own). Custom stages are saved in
// flow_json.pipeline — never flow_json.stages, which drives the bot. Same hermetic file:// setup as
// leads-staff-scope.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

async function setup(page, { industry, flow = {}, leads = [] }) {
  const patches = [];
  let saved = {};
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'file:') return route.continue();
    const req = route.request();
    if (req.method() === 'PATCH') { const b = JSON.parse(req.postData()); patches.push(b); saved = { ...saved, ...b }; return route.fulfill({ json: {} }); }
    if (req.method() === 'GET' && /\/records\/7$/.test(url.pathname)) return route.fulfill({ json: { Id: 7, ...saved } });
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ industry, flow, leads }) => {
    sessionStorage.clear();
    // @ts-ignore
    clientId = '7'; myEmail = 'owner@biz.com'; allLeads = leads.map((l) => ({ ...l }));
    // @ts-ignore
    clientRecord = { Id: 7, client_name: 'Test', authentik_email: 'owner@biz.com', industry, flow_json: JSON.stringify(flow) };
  }, { industry, flow, leads });
  return patches;
}
// @ts-ignore
const board = (page) => page.evaluate(() => pipelineBoardStages());

test('industries get default stages; Won/Lost sit after Human Handover', async ({ page }) => {
  await setup(page, { industry: 'real_estate' });
  expect(await board(page)).toEqual(['new', 'contacted', 'site_visit', 'negotiation', 'booking', 'human_handover', 'won', 'lost']);
  // @ts-ignore
  expect(await page.evaluate(() => stageLabel('won'))).toBe('Deal Closed');
});

test('travel gets no default stages; general only Proposal Sent (Chats → AI Proposal moves leads there)', async ({ page }) => {
  await setup(page, { industry: 'travel' });
  expect(await board(page)).toEqual(['new', 'human_handover']);
  await setup(page, { industry: 'general' });
  expect(await board(page)).toEqual(['new', 'proposal_sent', 'human_handover']);
  // @ts-ignore
  expect(await page.evaluate(() => stageLabel('proposal_sent'))).toBe('Proposal Sent');
});

test('bot flow stages stay on the board alongside the defaults', async ({ page }) => {
  await setup(page, { industry: 'education', flow: { stages: { new: {}, stage_1: {}, stage_2: {} } } });
  expect(await board(page)).toEqual(['new', 'stage_1', 'stage_2', 'contacted', 'counselling', 'application', 'fee_pending', 'human_handover', 'won', 'lost']);
});

test('kanban, stage filter and lead form all use the pipeline stages', async ({ page }) => {
  await setup(page, { industry: 'healthcare', leads: [{ Id: 1, Name: 'A', Stage: 'appt_booked' }] });
  // @ts-ignore
  await page.evaluate(() => { renderKanban(); populateFormSelects(''); });
  await expect(page.locator('#kbc-appt_booked .kb-hd')).toContainText('Appointment Booked');
  await expect(page.locator('#kbc-appt_booked .kb-card')).toHaveCount(1);
  await expect(page.locator('#fStage option[value="follow_up"]')).toHaveText('Follow Up');
});

test('customising saves flow_json.pipeline, keeps the bot flow and other flow keys', async ({ page }) => {
  const patches = await setup(page, { industry: 'automotive', flow: { intro: { text: 'Hi' }, stages: { new: {}, stage_1: {} } } });
  // @ts-ignore
  await page.evaluate(() => openPipelineStagesEditor());
  await expect(page.locator('#modalPipelineStages')).toHaveClass(/open/);
  await page.fill('#plNewStage', 'Delivery Scheduled');
  // The login gate overlays the app in file:// tests, so drive the buttons' handlers directly.
  // @ts-ignore
  await page.evaluate(() => plAddStage());
  // remove "Finance" (no leads in it, so no confirm)
  // @ts-ignore
  await page.evaluate(() => plRemove(_plEdit.findIndex((s) => s.id === 'finance')));
  // @ts-ignore
  await page.evaluate(() => { _plEdit.find((s) => s.id === 'contacted').label = 'Called'; _plEdit[0].label = 'Bot greeting'; });
  // the bot flow stage is listed first and can't be removed
  // @ts-ignore
  expect(await page.evaluate(() => _plEdit[0])).toMatchObject({ id: 'stage_1', bot: true });
  await expect(page.locator('#plStageRows [title="Bot flow stage — always kept"]')).toHaveCount(1);
  // @ts-ignore
  await page.evaluate(() => savePipelineStages());
  await expect(page.locator('#modalPipelineStages')).not.toHaveClass(/open/);
  const flow = JSON.parse(patches.at(-1).flow_json);
  expect(flow.intro).toEqual({ text: 'Hi' });
  expect(Object.keys(flow.stages)).toEqual(['new', 'stage_1']);
  expect(flow.pipeline.map((s) => s.id)).toEqual(['stage_1', 'contacted', 'test_drive', 'quotation', 'delivery_scheduled', 'won', 'lost']);
  expect(flow.labels).toEqual({ stage_1: 'Bot greeting' });
  expect(await board(page)).toEqual(['new', 'stage_1', 'contacted', 'test_drive', 'quotation', 'delivery_scheduled', 'human_handover', 'won', 'lost']);
  // @ts-ignore
  expect(await page.evaluate(() => stageLabel('stage_1'))).toBe('Bot greeting');
  // @ts-ignore
  expect(await page.evaluate(() => stageLabel('contacted'))).toBe('Called');
});

test('general clients can add their own stages', async ({ page }) => {
  await setup(page, { industry: 'general' });
  // @ts-ignore
  await page.evaluate(() => openPipelineStagesEditor());
  await page.fill('#plNewStage', 'Quoted');
  await page.dispatchEvent('#plNewStage', 'keydown', { key: 'Enter' });
  // @ts-ignore
  await page.evaluate(() => savePipelineStages());
  expect(await board(page)).toEqual(['new', 'proposal_sent', 'quoted', 'human_handover']);
});
