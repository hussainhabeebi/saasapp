// Settings → 📇 People & Contacts: identity, custom departments, default, preview and save
// (GET/POST /settings/contacts), plus the read-only view for staff.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

const empty = {
  identity: { official_name: '', short_name: '', address: '', map_url: '', hours: '', phone: '', whatsapp: '', email: '', website: '', logo_url: '', logo_wide_url: '' },
  departments: [
    { id: 'd1', name: 'Sales', person: '', phone: '', whatsapp: true, email: '', hours: '', handles: 'packages, bookings', public: true, is_default: true, teammate: '' },
    { id: 'd2', name: 'Tech support', person: '', phone: '', whatsapp: true, email: '', hours: '', handles: 'payment links', public: true, is_default: false, teammate: '' },
  ],
  guard: true,
};

async function open(page, { canManage = true } = {}) {
  const posts = [];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://')) return route.continue();
    if (url.endsWith('/settings/contacts') && req.method() === 'GET')
      return route.fulfill({ json: { data: empty, saved: false, prompt_block: '', can_manage: canManage, logo_upload: true,
        billing: { client_name: 'Tripcode Travels LLC', company_address: 'Deira, Dubai', billing_email: 'accounts@tripcode.ae' },
        teammates: [{ email: 'rahul@tripcode.ae', name: 'Rahul' }] } });
    if (url.endsWith('/settings/contacts') && req.method() === 'POST') {
      const b = JSON.parse(req.postData()); posts.push(b);
      return route.fulfill({ json: { ok: true, data: b.data, prompt_block: '\n\n## Official business details — use exactly as written\nOfficial name: ' + b.data.identity.official_name } });
    }
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    sessionToken = 't';
    // @ts-ignore
    navigate('peoplecontacts');
  });
  return posts;
}

test('owner fills identity, adds a custom department, picks the default and saves', async ({ page }) => {
  const posts = await open(page);
  await expect(page.locator('#pagePeoplecontacts')).toBeVisible();
  await expect(page.locator('#pagePeoplecontacts .ssnav-btn[data-subpage="peoplecontacts"]')).toHaveClass(/active/);
  await expect(page.locator('#pcDeptRows [data-dept]')).toHaveCount(2);

  await page.getByRole('button', { name: 'Same as billing (Company Profile)' }).click();
  await expect(page.locator('#pcId_official_name')).toHaveValue('Tripcode Travels LLC');
  await page.locator('#pcId_phone').fill('+971 52 931 9100');

  const sales = page.locator('#pcDeptRows [data-dept="d1"]');
  await sales.locator('[data-f="person"]').fill('Rahul');
  await sales.locator('[data-f="phone"]').fill('+971 52 931 9100');

  await page.getByRole('button', { name: '＋ Add department' }).click();
  const visa = page.locator('#pcDeptRows [data-dept]').nth(2);
  await visa.locator('[data-f="name"]').fill('Visa');
  await visa.locator('[data-f="phone"]').fill('+971 50 111 2222');
  await visa.locator('[data-f="handles"]').fill('visa status');
  await visa.locator('input[name="pcDefault"]').check();

  await expect(page.locator('#pcPreview')).toContainText('- Visa (visa status): +971 50 111 2222 (call / WhatsApp)  [DEFAULT]');
  await expect(page.locator('#pcPreview')).toContainText('Official name: Tripcode Travels LLC');

  await page.getByRole('button', { name: 'Save People & Contacts' }).click();
  await expect(page.locator('#pcSaveMsg')).toContainText('Saved');
  expect(posts).toHaveLength(1);
  const d = posts[0].data;
  expect(d.identity.official_name).toBe('Tripcode Travels LLC');
  expect(d.identity.email).toBe('accounts@tripcode.ae');
  expect(d.departments.map(x => x.name)).toEqual(['Sales', 'Tech support', 'Visa']);
  expect(d.departments.map(x => x.is_default)).toEqual([false, false, true]);
  expect(d.departments[0].person).toBe('Rahul');
  expect(d.guard).toBe(true);
});

test('a hidden department stays out of the preview', async ({ page }) => {
  await open(page);
  const tech = page.locator('#pcDeptRows [data-dept="d2"]');
  await tech.locator('[data-f="phone"]').fill('+971 55 999 8888');
  await expect(page.locator('#pcPreview')).toContainText('999 8888');
  await tech.locator('[data-f="public"]').uncheck();
  await expect(page.locator('#pcPreview')).not.toContainText('999 8888');
});

test('staff see the details read-only', async ({ page }) => {
  await open(page, { canManage: false });
  await expect(page.locator('#pcRoot')).toContainText('Only the account owner or an Admin can change these.');
  await expect(page.locator('#pcId_official_name')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save People & Contacts' })).toHaveCount(0);
});

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('one logo upload: page copy, print JPEG and the Quotation/top-bar logo together', async ({ page }) => {
  const uploads = [];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://') || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    if (url.endsWith('/settings/contacts') && req.method() === 'GET')
      return route.fulfill({ json: { data: empty, saved: false, prompt_block: '', can_manage: true, logo_upload: true, billing: {}, teammates: [] } });
    if (url.endsWith('/settings/contacts/logo')) {
      const body = req.postDataBuffer()?.toString('latin1') || '';
      const variant = /name="variant"\r\n\r\n(\w+)/.exec(body)?.[1];
      const type = /Content-Type: (image\/\w+)/.exec(body)?.[1];
      uploads.push({ variant, type });
      return route.fulfill({ json: { ok: true, variant, url: `https://w.example/brand/logo/brandlogo/7/${variant}-x.${variant === 'print' ? 'jpg' : 'png'}` } });
    }
    if (url.startsWith('https://w.example/brand/logo/')) return route.fulfill({ contentType: 'image/png', body: PNG });
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('app').classList.add('show');
    document.getElementById('gate')?.style.setProperty('display', 'none');
    // @ts-ignore
    sessionToken = 't'; clientRecord = { Id: 7, quote_logo_url: '' };
    // @ts-ignore
    window.__patches = []; patchClient = async (f) => { window.__patches.push(f); };
    // @ts-ignore
    navigate('peoplecontacts');
  });
  await expect(page.locator('#pcLogoFile_square')).toHaveCount(1);
  await page.locator('#pcLogoFile_square').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('#pcLogoMsg')).toContainText('Logo saved');
  expect(uploads).toEqual([{ variant: 'square', type: 'image/png' }, { variant: 'print', type: 'image/jpeg' }]);
  // @ts-ignore
  const patches = await page.evaluate(() => window.__patches);
  expect(patches).toHaveLength(1);
  expect(patches[0].quote_logo_url).toMatch(/^data:image\/(png|jpeg);base64,/);
  await expect(page.locator('#hLogo')).toHaveAttribute('src', /^data:image/);
  await expect(page.locator('#pcRoot img[alt="Logo (square)"]')).toHaveAttribute('src', /square-x\.png$/);
});

test('the store page shows the official logo next to the name', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('/ecom/public/client')) return route.fulfill({ json: { client_name: 'Tripcode Store', logo_url: 'https://w.example/brand/logo/brandlogo/7/square-x.png' } });
    if (url.includes('/ecom/public/products')) return route.fulfill({ json: { list: [] } });
    if (url.startsWith('https://w.example/brand/logo/')) return route.fulfill({ contentType: 'image/png', body: PNG });
    return route.abort();
  });
  await page.goto('file://' + path.resolve(__dirname, '../store.html') + '?client_id=7', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#storeName')).toContainText('Tripcode Store');
  await expect(page.locator('#storeName img.brand-logo')).toHaveAttribute('src', /square-x\.png$/);
});
