// User Management → ✉️ Invite Teammate, the ?invite= link from the invite email, and the emailed
// sign-in link's new-tab callback retry. Same hermetic file:// setup as hot-alerts.spec.js.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');
const WORKER = 'https://leadvyne-api-proxy.leadvyne.workers.dev';
const AUTHENTIK = 'https://secure.leadvyne.com';
const INVITE_ID = '0b0c5c8e-1111-4222-8333-944445555666';

// Routes Worker calls to `worker`, records every Authentik navigation, and answers it with a stub.
async function stub(page, worker = () => null) {
  const calls = [], authentik = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.startsWith(AUTHENTIK)) { authentik.push(url); return route.fulfill({ contentType: 'text/html', body: '<p>authentik</p>' }); }
    if (url.startsWith(WORKER)) {
      const p = new URL(url).pathname;
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ path: p, body });
      const res = worker(p, body);
      if (res) return route.fulfill(res);
    }
    return route.abort();
  });
  return { calls, authentik };
}

test('owner invites a teammate by name and email and gets a shareable link', async ({ page }) => {
  const { calls } = await stub(page, (p, body) => p === '/team/invite'
    ? { json: { ok: true, email: body.email, inviteLink: `https://app.leadvyne.com/dashboard.html?invite=${INVITE_ID}`, inviteEmailSent: true, expiresAt: '2026-10-08T00:00:00Z', chatwoot: null } }
    : null);
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('pageUsermanagement').classList.remove('hidden');
    // @ts-ignore
    clientId = 7; clientRecord = { Id: 7, authentik_email: 'boss@x.com', team_emails: 'a@x.com' }; sessionToken = 't'; myEmail = 'boss@x.com';
  });

  // The invite form comes before the password-based one.
  const card = page.locator('#userMgmtCard2');
  const headings = await card.locator('div[style*="font-weight:700;font-size:13px"]').allTextContents();
  expect(headings.indexOf('✉️ Invite Teammate')).toBeLessThan(headings.indexOf('Or Create User With a Password'));

  await page.locator('#teamInviteName').fill('Sara K');
  await page.locator('#teamInviteEmail').fill('Sara@X.com');
  await card.getByRole('button', { name: 'Send Invite' }).click();
  await expect(page.locator('#teamInviteMsg')).toHaveText('✓ Invite sent');
  expect(calls.find((c) => c.path === '/team/invite').body).toEqual({ name: 'Sara K', email: 'sara@x.com' });
  await expect(page.locator('#teamInviteResult')).toContainText(`?invite=${INVITE_ID}`);
  await expect(page.locator('#teamInviteResult')).toContainText('Invite emailed to sara@x.com');
  await expect(page.locator('#teamMembersList')).toContainText('sara@x.com');
});

test('opening an invite link goes to the Authentik invite flow with a PKCE login as next', async ({ page }) => {
  const { authentik } = await stub(page);
  await page.goto(`${dashboardUrl}?invite=${INVITE_ID}`);
  await expect.poll(() => authentik.length).toBe(1);
  const u = new URL(authentik[0]);
  expect(u.pathname).toBe('/if/flow/leadvyne-team-invite/');
  expect(u.searchParams.get('itoken')).toBe(INVITE_ID);
  const next = new URL(u.searchParams.get('next'), AUTHENTIK);
  expect(next.pathname).toBe('/application/o/authorize/');
  expect(next.searchParams.get('code_challenge_method')).toBe('S256');
  expect(next.searchParams.get('redirect_uri')).toBe('https://app.leadvyne.com/dashboard.html');
});

test('a malformed invite id is ignored', async ({ page }) => {
  const { authentik } = await stub(page);
  await page.goto(`${dashboardUrl}?invite=../../evil`);
  await page.waitForTimeout(300);
  // (The normal silent-login iframe may still hit /authorize/?prompt=none — that's expected.)
  expect(authentik.filter((u) => u.includes('/if/flow/'))).toEqual([]);
});

test('sign-in link option is hidden until the magic-link flow is configured', async ({ page }) => {
  await stub(page);
  await page.goto(dashboardUrl, { waitUntil: 'load' });
  await expect(page.locator('#gMagicLink')).toBeHidden();
});

test('a callback in a tab without the PKCE verifier retries authorize once, then gives up', async ({ page }) => {
  const { authentik } = await stub(page);
  // First arrival (e.g. the emailed link opened in a new tab): silently restarts authorize.
  await page.goto(`${dashboardUrl}?code=abc&state=xyz`);
  await expect.poll(() => authentik.length).toBe(1);
  expect(new URL(authentik[0]).pathname).toBe('/application/o/authorize/');
  // Coming back without a matching verifier again must not loop.
  await page.goto(`${dashboardUrl}?code=abc&state=other`);
  await expect(page.locator('#gErr')).toContainText('Login session expired');
  expect(authentik.length).toBe(1);
});
