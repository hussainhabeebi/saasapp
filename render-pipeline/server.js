// Render pipeline server for the Marketing Studio module (see SETUP.md "Marketing Studio module"
// for the full contract). Receives a signed render spec from the Worker's
// POST /marketing/projects/render (or /marketing/templates/generate), renders it with ffmpeg,
// and calls back to POST /marketing/webhook/render-complete with the result — the async job
// pattern documented there, not a synchronous request/response.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');

const hmac = require('./lib/hmac');
const { renderCaptionClip } = require('./lib/render');
const { renderTemplate } = require('./lib/templateRender');
const { renderRemotionTemplate } = require('./lib/remotionRender');
const { extractAudio } = require('./lib/extractAudio');
const { concatClips } = require('./lib/concatClips');
const { transcribe } = require('./lib/transcribe');

const env = process.env;
const PORT = env.PORT || 8787;
const ASSETS_ROOT = env.ASSETS_ROOT || path.join(__dirname, 'assets');

if (!env.RENDER_WEBHOOK_SECRET) {
  console.error('RENDER_WEBHOOK_SECRET is not set — see .env.example. Refusing to start.');
  process.exit(1);
}

const app = express();

// Raw body is needed for HMAC verification (must be the exact bytes the Worker signed) — capture
// it alongside the parsed JSON rather than re-serializing, which could byte-for-byte differ.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Local-fallback static serving for LOCAL_PUBLIC_BASE_URL mode (see lib/storage.js) — only
// relevant when R2 credentials aren't configured, e.g. running this locally without Cloudflare.
app.use('/public', express.static(env.LOCAL_PUBLIC_DIR || path.join(__dirname, 'public')));

// A tiny in-process queue, not a distributed one — this is meant to run as ONE instance, since
// ffmpeg renders are CPU-heavy and running several at once on typical hardware just makes every
// render slower, not faster. Scale by running a bigger box, not more replicas, unless you also
// change this to a real job queue (Redis/SQS/etc — not built here).
const queue = [];
let draining = false;

app.post('/render', (req, res) => {
  const signature = req.header('X-Signature');
  if (!hmac.verify(env.RENDER_WEBHOOK_SECRET, req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const job = req.body;
  if (!job || !job.job_id || !job.spec || !job.callback_url) {
    return res.status(400).json({ error: 'job_id, spec and callback_url are required' });
  }
  queue.push(job);
  res.status(202).json({ ok: true, queued_position: queue.length });
  drainQueue();
});

// Synchronous, not queued like /render — this is a quick ffmpeg pass (strip video, re-encode
// audio), not a full render, and the Worker is waiting on the response inline (see worker.js's
// handleMarketingTranscribe) to forward the result straight to the transcription API. Real fix
// for a real bug: OpenAI's Whisper endpoint hard-caps requests at 25 MB, and sending the whole
// video (not just its audio) was hitting that on perfectly reasonable video files. Same
// HMAC-over-raw-body auth as /render, reusing RENDER_WEBHOOK_SECRET — one shared secret for both
// routes rather than a second one to configure.
app.post('/extract-audio', async (req, res) => {
  const signature = req.header('X-Signature');
  if (!hmac.verify(env.RENDER_WEBHOOK_SECRET, req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { source_url } = req.body || {};
  if (!source_url) return res.status(400).json({ error: 'source_url required' });
  try {
    const audioBuffer = await extractAudio(source_url);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch (err) {
    console.error('extract-audio failed:', err.stderr || err.message || err);
    res.status(502).json({ error: String(err.message || err).slice(0, 500) });
  }
});

// Also synchronous (not queued) — same reasoning as /extract-audio: one bounded ffmpeg pass
// (normalize + concat a handful of clips), not the multi-step render pipeline, and the Worker's
// "combine my clips" action is waiting on the result inline.
app.post('/concat-clips', async (req, res) => {
  const signature = req.header('X-Signature');
  if (!hmac.verify(env.RENDER_WEBHOOK_SECRET, req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { source_urls, resolution, client_id, project_id } = req.body || {};
  if (!Array.isArray(source_urls) || !source_urls.length) return res.status(400).json({ error: 'source_urls (a non-empty array) required' });
  try {
    const result = await concatClips(env, source_urls, resolution, client_id, project_id);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('concat-clips failed:', err.stderr || err.message || err);
    res.status(502).json({ error: String(err.message || err).slice(0, 500) });
  }
});

// Also synchronous, same reasoning as /extract-audio and /concat-clips — one bounded external API
// call, and the Worker is waiting on the result inline. Calls OpenAI from THIS server's fixed
// location instead of from the Worker's globally-distributed edge network — see lib/transcribe.js
// for why that distinction actually matters (a real "Country, region, or territory not supported"
// error from OpenAI, not a hypothetical). MARKETING_TRANSCRIBE_API_KEY lives here now, not on the
// Worker.
app.post('/transcribe', async (req, res) => {
  const signature = req.header('X-Signature');
  if (!hmac.verify(env.RENDER_WEBHOOK_SECRET, req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { source_url, language } = req.body || {};
  if (!source_url) return res.status(400).json({ error: 'source_url required' });
  try {
    const data = await transcribe(source_url, language, env);
    res.json(data);
  } catch (err) {
    console.error('transcribe failed:', err.stderr || err.message || err);
    res.status(err.status && err.status < 500 ? err.status : 502).json({ error: String(err.message || err).slice(0, 500) });
  }
});

async function drainQueue() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const job = queue.shift();
    await processJob(job).catch(err => console.error(`Job ${job.job_id} crashed outside its own error handling:`, err));
  }
  draining = false;
}

async function processJob(job) {
  console.log(`[job ${job.job_id}] starting, mode=${job.spec?.mode}`);
  try {
    const result = job.spec?.mode === 'template'
      ? (job.spec?.engine === 'remotion' ? await renderRemotionTemplate(job, env) : await renderTemplate(job, env))
      : await renderCaptionClip(job, env, ASSETS_ROOT);
    console.log(`[job ${job.job_id}] done`, result);
    await callback(job, { job_id: job.job_id, status: 'done', ...result });
  } catch (err) {
    console.error(`[job ${job.job_id}] failed:`, err.stderr || err.message || err);
    await callback(job, { job_id: job.job_id, status: 'failed', error: String(err.message || err).slice(0, 500) });
  }
}

async function callback(job, payload) {
  const body = JSON.stringify(payload);
  const signature = hmac.sign(env.RENDER_WEBHOOK_SECRET, body);
  try {
    const r = await fetch(job.callback_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
      body,
    });
    if (!r.ok) console.error(`[job ${job.job_id}] callback returned HTTP ${r.status}`);
  } catch (err) {
    console.error(`[job ${job.job_id}] callback request failed:`, err.message);
  }
}

fs.mkdirSync(path.join(ASSETS_ROOT, 'broll'), { recursive: true });
fs.mkdirSync(path.join(ASSETS_ROOT, 'sfx'), { recursive: true });
fs.mkdirSync(path.join(ASSETS_ROOT, 'music'), { recursive: true });

app.listen(PORT, () => console.log(`Marketing Studio render pipeline listening on :${PORT}`));
