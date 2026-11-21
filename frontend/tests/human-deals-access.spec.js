// Human Deals is open to every role (dashboard.html ALWAYS_ON_MODULES / applyUserModulePermissions),
// and the queue refreshes when lead data arrives while it's open (renderHome). Same hermetic
// file:// setup as the other specs — no backend.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

async function boot(page) {
  await page.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
  });
}

for (const role of ['admin', 'general_manager', 'sales_manager', 'marketing_manager', 'telecaller']) {
  test(`${role}: Human Deals tab stays visible`, async ({ page }) => {
    await boot(page);
    await page.evaluate((role) => {
      // @ts-ignore
      const r = ROLES[role];
      // @ts-ignore
      myEmail = 'rep@example.com';
      // @ts-ignore
      clientRecord = { authentik_email: 'owner@example.com',
        team_permissions: JSON.stringify({ 'rep@example.com': { role, modules: r.modules } }) };
      // @ts-ignore
      applyUserModulePermissions();
    }, role);
    await expect(page.locator('#dnHumandealsTab')).not.toHaveCSS('display', 'none');
    await expect(page.locator('#bnHumandealsTab')).not.toHaveCSS('display', 'none');
  });
}

test('a custom module list without Human Deals still shows it', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    // @ts-ignore
    myEmail = 'rep@example.com';
    // @ts-ignore
    clientRecord = { authentik_email: 'owner@example.com',
      team_permissions: JSON.stringify({ 'rep@example.com': { modules: ['home', 'leads'] } }) };
    // @ts-ignore
    applyUserModulePermissions();
  });
  await expect(page.locator('#bnHumandealsTab')).not.toHaveCSS('display', 'none');
  // ...while modules that really are restricted still hide.
  await expect(page.locator('[data-page="reports"]').first()).toHaveCSS('display', 'none');
});

test('every role preset includes Human Deals', async ({ page }) => {
  await boot(page);
  // @ts-ignore
  const missing = await page.evaluate(() => Object.entries(ROLES).filter(([, r]) => r.modules && !r.modules.includes('humandeals')).map(([k]) => k));
  expect(missing).toEqual([]);
});

test('queue opened before leads load fills in when they arrive', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    // @ts-ignore
    clientRecord = {};
    // @ts-ignore
    allLeads = [];
    // @ts-ignore
    navigate('humandeals');
  });
  await expect(page.locator('#hdEmpty')).toBeVisible();
  await page.evaluate(() => {
    // @ts-ignore
    allLeads = [{ Id: 9, Name: 'Waiting Customer', Phone: '971500000009', Stage: 'human_handover', Handover: 'Yes', HandoverAt: new Date().toISOString() }];
    // @ts-ignore
    renderHome();
  });
  await expect(page.locator('#hdGrid')).toContainText('Waiting Customer');
});
