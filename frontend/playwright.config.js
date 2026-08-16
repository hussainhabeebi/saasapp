// @ts-check
import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Smoke tests only — no dev server, no live backend. Every test loads a static HTML file
// directly (file://) with all network requests blocked (see tests/*.spec.js), so these run
// hermetically in CI with no NocoDB/Chatwoot/Authentik credentials needed.
//
// executablePath: some sandboxes (this one included) pre-install a specific Chromium build at a
// fixed path instead of the version `npx playwright install` would normally fetch, which can lag
// behind whatever @playwright/test itself expects. If that fixed path exists, use it directly
// (skips a redundant download); otherwise fall back to Playwright's own default resolution — the
// normal path for real CI, which runs `npx playwright install --with-deps chromium` first.
const sandboxChromium = '/opt/pw-browsers/chromium';
const executablePath = existsSync(sandboxChromium) ? sandboxChromium : undefined;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
});
