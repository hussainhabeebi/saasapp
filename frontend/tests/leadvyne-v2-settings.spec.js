// Settings → Bot Behavior → 🧠 Leadvyne v2: one Save at the bottom stores the toggle, the 360° video,
// its "send again after N days", source rules and the nudge. NocoDB passthrough is stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';

async function openPage(page, botConfig) {
  let record = { Id: 7, bot_config: JSON.stringify(botConfig) };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(WORKER + '/nocodb/') && /\/records/.test(url)) {
      if (req.method() === 'PATCH') { record = { ...record, ...JSON.parse(req.postData()) }; return route.fulfill({ json: [{ Id: 7 }] }); }
      if (req.method() === 'GET') return route.fulfill({ json: record });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((rec) => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageBotbehavior').classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = { ...rec }; sessionToken = 't';
    // @ts-ignore
    populateBotBehaviorPage();
  }, record);
  return () => JSON.parse(record.bot_config || '{}');
}

test('video link, return days and nudge are saved by the one Save button below them', async ({ page }) => {
  const saved = await openPage(page, {});
  await expect(page.locator('#v2StatusNote')).toContainText('OFF');
  await page.selectOption('#cfgLeadvyneV2', 'Yes');
  await page.fill('#cfgV2WelcomeVideoUrl', 'https://drive.google.com/file/d/abc/view');
  await page.fill('#cfgV2WelcomeVideoCaption', 'Hi {name}!');
  await page.fill('#cfgV2VideoReturnDays', '7');
  await page.fill('#cfgV2SourceVideos', 'villa | https://drive.google.com/file/d/v/view | Villa tour');
  await page.selectOption('#cfgV2NudgeEnabled', 'Yes');
  // Save sits below the last v2 field, so nothing typed above it looks unsaveable.
  const saveBox = await page.locator('#saveLeadvyneV2').boundingBox();
  const nudgeBox = await page.locator('#cfgV2NudgeText').boundingBox();
  expect(saveBox.y).toBeGreaterThan(nudgeBox.y);
  await page.click('#saveLeadvyneV2');
  await expect(page.locator('#saveLeadvyneV2Msg')).toHaveText('✓ Saved');
  expect(saved()).toEqual({
    leadvyne_v2: true,
    v2_welcome_video_url: 'https://drive.google.com/file/d/abc/view',
    v2_welcome_video_caption: 'Hi {name}!',
    v2_source_videos: [{ match: 'villa', video_url: 'https://drive.google.com/file/d/v/view', caption: 'Villa tour' }],
    v2_nudge_enabled: true,
    v2_welcome_video_return_days: 7,
  });
  await expect(page.locator('#v2StatusNote')).toContainText('Leadvyne v2 is ON');
  await expect(page.locator('#v2StatusNote')).toContainText('again after 7 days');
});

test('a non-Drive video link is refused, nothing saved', async ({ page }) => {
  const saved = await openPage(page, { leadvyne_v2: true });
  await page.fill('#cfgV2WelcomeVideoUrl', 'https://youtube.com/watch?v=x');
  await page.click('#saveLeadvyneV2');
  await expect(page.locator('#saveLeadvyneV2Msg')).toHaveText('Video must be a Google Drive link');
  expect(saved()).toEqual({ leadvyne_v2: true });
});
