// users.html — the new User Management window (worker /team/members and the /team/member/* routes).
// Hermetic file:// load; the worker API is stubbed.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + path.resolve(__dirname, '../users.html') + '?token=t';
const day = (n) => new Date(Date.now() + n * 86400000).toISOString();
const members = (me = { email: 'boss@acme.com', is_owner: true, can_manage: true }) => ({
  me, account: { id: '7', name: 'Acme Travels' }, owner: { email: 'boss@acme.com', name: 'Acme Travels', whatsapp: '', last_login_at: day(-0.1) },
  members: [
    { email: 'anurag@gmail.com', name: 'Anurag M', status: 'active', role: 'telecaller', modules: ['home', 'chats', 'leads', 'tasks', 'humandeals'], whatsapp: '', chatwoot: false, last_login_at: day(-1) },
    { email: 'vinod@acme.com', name: 'Vinod', status: 'pending', role: null, modules: null, whatsapp: '', chatwoot: false, invited_at: day(-1), expires_at: day(6) },
    { email: 'meera@acme.com', name: 'Meera', status: 'deactivated', role: null, modules: null, whatsapp: '', chatwoot: false },
  ],
  channels: [{ id: '11', name: 'Sales', type: 'whatsapp', phone: '+971 50 1', assigned_email: '', strict: false }, { id: '22', name: 'VIP', type: 'whatsapp', phone: '', assigned_email: 'boss@acme.com', strict: true }],
  seats: { used: 3, max: 5, plan: 'Growth' }, roles: [], modules: [], invite_ttl_days: 7,
});

async function stub(page, data, calls) {
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://') || url.includes('fonts.g')) return url.startsWith('file://') ? route.continue() : route.abort();
    const p = new URL(url).pathname;
    calls.push({ path: p, body: req.postData() ? JSON.parse(req.postData()) : null });
    if (p === '/team/members') return route.fulfill({ json: data });
    if (p === '/team/diagnose') return route.fulfill({ json: { email: 'anuragmc914@gmail.com', status: 'orphan_account', message: 'This email has an empty Leadvyne account that was created by mistake.', fix: 'repair', login: { exists: true }, member: null, other_account: { id: '55', name: 'Anuragmc914', kind: 'owner', empty: true } } });
    if (p === '/team/reassign-leads') return route.fulfill({ json: { moved: 2, remaining: 0 } });
    return route.fulfill({ json: { ok: true } });
  });
}

test('lists the team with statuses, filters, and saves a role from the member panel', async ({ page }) => {
  const calls = [];
  await stub(page, members(), calls);
  await page.goto(pageUrl);
  await expect(page.locator('#rows')).toContainText('Anurag M');
  await expect(page.locator('#rows')).toContainText('Invite sent');
  await expect(page.locator('#rows')).toContainText('Deactivated');
  await page.getByRole('button', { name: 'Invites', exact: true }).click();
  await expect(page.locator('#rows tr.row')).toHaveCount(1);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByText('Anurag M').click();
  await expect(page.locator('#drawer')).toHaveClass(/on/);
  await page.locator('#dRole').selectOption('sales_manager');
  await page.getByRole('button', { name: 'Save role & access' }).click();
  await expect.poll(() => calls.find(c => c.path === '/team/member/update')?.body?.role).toBe('sales_manager');
});

test('deactivate reassigns leads; fix-a-user offers "Move to my team"', async ({ page }) => {
  const calls = [];
  await stub(page, members(), calls);
  page.on('dialog', d => d.accept());
  await page.goto(pageUrl);
  await page.getByText('Anurag M').click();
  await page.getByRole('button', { name: '⏸️ Deactivate' }).click();
  await expect.poll(() => calls.some(c => c.path === '/team/reassign-leads' && c.body.from === 'anurag@gmail.com')).toBe(true);
  expect(calls.find(c => c.path === '/team/member/deactivate').body).toEqual({ email: 'anurag@gmail.com', remove: false });
  await page.getByRole('tab', { name: 'Fix a user' }).click();
  await page.locator('#fixEmail').fill('anuragmc914@gmail.com');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText('Has an empty account created by mistake')).toBeVisible();
  await page.getByRole('button', { name: 'Move to my team' }).click();
  await expect.poll(() => calls.some(c => c.path === '/team/repair')).toBe(true);
});

test('a teammate without manage rights sees the team read-only', async ({ page }) => {
  await stub(page, members({ email: 'anurag@gmail.com', is_owner: false, can_manage: false }), []);
  await page.goto(pageUrl);
  await expect(page.getByText('Only the account owner or an Admin can make changes')).toBeVisible();
  await expect(page.locator('#inviteBtn')).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Fix a user' })).toHaveCount(0);
});

test('lead and channel access are saved with the role', async ({ page }) => {
  const calls = [];
  await stub(page, members(), calls);
  await page.goto(pageUrl);
  await page.getByText('Anurag M').click();
  await page.locator('#dLeads').getByRole('button', { name: 'Read only' }).click();
  await page.locator('select[data-ch="11"]').selectOption('read');
  await page.locator('select[data-ch="22"]').selectOption('full');
  await page.getByRole('button', { name: 'Save role & access' }).click();
  await expect.poll(() => calls.find(c => c.path === '/team/member/update')?.body).toMatchObject({ email: 'anurag@gmail.com', leads: 'read', channels: { 11: 'read', 22: 'full' } });
});
