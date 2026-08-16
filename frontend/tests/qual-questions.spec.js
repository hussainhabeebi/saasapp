// Regression test for the qual_questions "Choices" editor (dashboard.html) — see
// ../../FIXES.md for the full log. Before editing loadQualQuestions/renderQualQuestions/
// addQualQuestion/saveQualQuestions in dashboard.html, read that entry first.
//
// Loads dashboard.html directly as a static file with every network request blocked, then
// drives the page's own global functions exactly as a real browser session would — no login,
// no NocoDB/Chatwoot backend, no mocking of unrelated app state needed. This works because
// renderQualQuestions/addQualQuestion/saveQualQuestions/$id/patchClient are all top-level
// `function` declarations, which attach directly to `window` the moment the script tag parses,
// independent of whether the rest of the app (session/data load) ever finishes booting.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardUrl = 'file://' + path.resolve(__dirname, '../dashboard.html');

test.beforeEach(async ({ page }) => {
  // Hermetic: block every real network request (session checks, NocoDB, etc.) so this test
  // never depends on — or accidentally hits — a live backend.
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    return route.abort();
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
});

test('a qualifying question\'s typed Choices become a real options array on save', async ({ page }) => {
  // patchClient is the only thing that would otherwise make a real network call — capture what
  // it's called with instead of letting it fire.
  await page.evaluate(() => {
    // @ts-ignore
    window.patchClient = async (fields) => { window.__lastPatch = fields; return {}; };
  });

  await page.evaluate(() => window.addQualQuestion());

  const captured = await page.evaluate(async () => {
    const list = document.getElementById('qualQuestionList');
    const inputs = list.querySelectorAll('input.form-input');
    inputs[0].value = 'Do you need a mattress, a wooden bed, or something else?';
    inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = 'Mattress, Wooden bed, Something else';
    inputs[1].dispatchEvent(new Event('input'));
    await window.saveQualQuestions();
    return window.__lastPatch;
  });

  expect(captured).toBeTruthy();
  const saved = JSON.parse(captured.qual_questions);
  expect(saved).toEqual([
    {
      text: 'Do you need a mattress, a wooden bed, or something else?',
      optional: false,
      options: ['Mattress', 'Wooden bed', 'Something else'],
    },
  ]);
});

test('a question with no Choices typed saves as plain free text (unchanged behavior)', async ({ page }) => {
  await page.evaluate(() => {
    // @ts-ignore
    window.patchClient = async (fields) => { window.__lastPatch = fields; return {}; };
  });

  await page.evaluate(() => window.addQualQuestion());

  const captured = await page.evaluate(async () => {
    const list = document.getElementById('qualQuestionList');
    const inputs = list.querySelectorAll('input.form-input');
    inputs[0].value = "What's your budget?";
    inputs[0].dispatchEvent(new Event('input'));
    await window.saveQualQuestions();
    return window.__lastPatch;
  });

  const saved = JSON.parse(captured.qual_questions);
  expect(saved).toEqual([{ text: "What's your budget?", optional: false, options: [] }]);
});
