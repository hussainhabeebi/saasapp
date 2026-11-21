// Log Call → Save on a phone with a flaky connection: the button shows it is saving, a request that
// never answers times out with a "Call not saved" toast instead of leaving Save dead until a reload,
// and the next tap saves the call.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

test('a hung save times out, shows an error, and the next tap saves', async ({ page }) => {
  let hang = true;
  const patches = [];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (!/nocodb/.test(url.pathname)) return route.abort();
    if (req.method() === 'PATCH') {
      if (hang) return; // the connection drops — no answer ever comes
      patches.push(req.postDataJSON());
      return route.fulfill({ json: { Id: 1 } });
    }
    return route.fulfill({ json: { Id: 1, Owner: 'a@b.c', CallLog: '[]', list: [] } });
  });
  await page.goto('file://' + path.resolve(__dirname, '../dashboard.html'), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    myEmail = 'a@b.c';
    // @ts-ignore
    allLeads = [{ Id: 1, Name: 'kk', Owner: 'a@b.c', Date: new Date().toISOString(), CallLog: '[]' }];
    // @ts-ignore — shorten the save timeout for the test
    const orig = window.appendCallLog; window.appendCallLog = (l, e, o) => orig(l, e, o?.timeout ? { timeout: 1500 } : o);
    window.openCallLog(1);
  });
  const save = page.locator('#saveCallBtn');
  await expect(page.locator('#modalCall')).not.toContainText('Booked Consultations');
  await save.tap();
  await expect(save).toHaveText('Saving…');
  await expect(save).toBeDisabled();
  await expect(page.locator('body')).toContainText('Call not saved');
  await expect(save).toHaveText('Save Call');
  await expect(save).toBeEnabled();

  hang = false;
  await save.tap();
  await expect(page.locator('#modalCall')).not.toHaveClass(/open/);
  expect(patches.filter((p) => 'CallLog' in p)).toHaveLength(1);
});

test('Log Call for a lead not in the loaded list logs to that lead, not the previously open one', async ({ page }) => {
  const patches = [];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.protocol === 'file:') return route.continue();
    if (!/nocodb/.test(url.pathname)) return route.abort();
    if (req.method() === 'PATCH') { patches.push(req.postDataJSON()); return route.fulfill({ json: {} }); }
    return route.fulfill({ json: { CallLog: '[]', Owner: 'a@b.c', list: [] } });
  });
  await page.goto('file://' + path.resolve(__dirname, '../dashboard.html'), { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    // @ts-ignore
    myEmail = 'a@b.c';
    // @ts-ignore
    allLeads = [{ Id: 1, Name: 'Other', Owner: 'a@b.c', CallLog: '[]' }];
    // @ts-ignore
    currentLead = allLeads[0];
    window.openCallLog(99);
    await window.saveCall();
  });
  expect(patches.filter((p) => 'CallLog' in p).map((p) => p.Id)).toEqual([99]);
});
