// Render pipeline server for the Marketing Studio module (see SETUP.md "Marketing Studio module"
// for the full contract). Receives a signed render spec from the Worker's
// POST /marketing/projects/render (or /marketing/templates/generate), renders it with ffmpeg,
// and calls back to POST /marketing/webhook/render-complete with the result — the async job
// pattern documented there, not a synchronous request/response.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const express = require('express');

const hmac = require('./lib/hmac');
const { renderCaptionClip } = require('./lib/render');
const { renderTemplate } = require('./lib/templateRender');
const { renderRemotionTemplate } = require('./lib/remotionRender');
const { extractAudio } = require('./lib/extractAudio');
const { concatClips } = require('./lib/concatClips');
const { transcribe } = require('./lib/transcribe');
const { detectScenes, generateSceneThumbnails } = require('./lib/sceneDetect');
const { downloadToFile } = require('./lib/download');
const { generateAiBroll } = require('./lib/falBroll');
const { watermarkLogo, compositeOnColor, textOverlay, reframeToAspect } = require('./lib/imageCompose');
const { synthesizeVoiceover } = require('./lib/tts');
const { synthesizeWithAi4Bharat, supportsLanguage: ai4bharatTtsSupportsLanguage } = require('./lib/ai4bharatTts');
const { synthesizeWithPiper, supportsLanguage: piperSupportsLanguage, PIPER_VOICE_MAP } = require('./lib/piperTts');
const { pcmToOggOpus } = require('./lib/pcmToOgg');
const { uploadOutput } = require('./lib/storage');
const { MODEL_PATH } = require('./lib/segmentation');
const { createLiveSemaphore } = require('./lib/liveSemaphore');

// Bumped by hand alongside worker.js's MARKETING_BUILD_TAG (kept in sync manually, no shared
// source — these are two separately-deployed services). Same reasoning: repeated real confusion
// from Coolify restart-vs-rebuild ambiguity means "curl /health and eyeball the build tag" needs
// to be a fast, no-guessing check, not something re-derived from scratch every time.
const BUILD_TAG = '2026-09-05-fast-voice-hedge';

const env = process.env;
const PORT = env.PORT || 8787;
const ASSETS_ROOT = env.ASSETS_ROOT || path.join(__dirname, 'assets');
const ai4bharatLiveSemaphore = createLiveSemaphore(2);

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

// Reports real, checked facts about THIS running container, not just "the process is up" — the
// specific things that have gone stale/missing in practice when a deploy didn't actually rebuild
// the image (espeak-ng needs the Dockerfile's apt-get step; the RVM model needs its curl-download
// build step). A `build` tag mismatch or a `false` here means the container isn't running what
// was just pushed — curl this before assuming a "feature doesn't work" report is a code bug.
app.get('/health', (_req, res) => {
  const espeakAvailable = spawnSync('espeak-ng', ['--version']).status === 0;
  const piperBin = process.env.PIPER_BIN || '/opt/piper/piper';
  res.json({
    ok: true,
    build: BUILD_TAG,
    espeak_ng_available: espeakAvailable,
    rvm_model_present: fs.existsSync(MODEL_PATH),
    piper_available: fs.existsSync(piperBin),
    piper_voices: Object.keys(PIPER_VOICE_MAP).filter(lang => piperSupportsLanguage(lang)),
    ai4bharat_tts_active: ai4bharatLiveSemaphore.active,
    ai4bharat_tts_limit: ai4bharatLiveSemaphore.limit,
    ai4bharat_tts_enabled: Boolean(env.AI4BHARAT_TTS_ENABLED),
    ai4bharat_tts_timeout_ms: Math.max(5000, Number(env.AI4BHARAT_TTS_TIMEOUT_MS || 20000)),
  });
});

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

// Also synchronous, same reasoning as the routes above — one bounded ffmpeg analysis pass, and
// the Worker is waiting on the result inline. See lib/sceneDetect.js.
app.post('/detect-scenes', async (req, res) => {
  const signature = req.header('X-Signature');
  if (!hmac.verify(env.RENDER_WEBHOOK_SECRET, req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { source_url, client_id, project_id } = req.body || {};
  if (!source_url) return res.status(400).json({ error: 'source_url required' });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-scenes-'));
  try {
    const srcPath = path.join(workDir, 'source' + (path.extname(new URL(source_url).pathname) || '.mp4'));
    await downloadToFile(source_url, srcPath);
    const scenes = await detectScenes(srcPath);
    // Thumbnails are best-effort — only attempted when there's somewhere to put them and a
    // client/project to namespace the R2 keys under. A thumbnail failure never fails scene
    // detection itself (generateSceneThumbnails already degrades per-scene to null on its own).
    if (client_id && project_id) {
      const thumbs = await generateSceneThumbnails(srcPath, scenes, env, client_id, project_id);
      scenes.forEach((s, i) => { if (thumbs[i]) Object.assign(s, thumbs[i]); });
    }
    res.json({ ok: true, scenes });
  } catch (err) {
    console.error('detect-scenes failed:', err.stderr || err.message || err);
    res.status(502).json({ error: String(err.message || err).slice(0, 500) });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// Also synchronous, same reasoning as /detect-scenes above — a single bounded ffmpeg still-image
// pass (well under a second), not the multi-step video render. Four related, deterministic
// (no-AI) Image Studio operations sharing one route, distinguished by `mode` — see
// lib/imageCompose.js's own comment for why these are plain ffmpeg filters instead of a paid
// fal.ai call. `image_url`/`logo_url`/`cutout_url` are the Worker's own public
// GET /marketing/media/:key URLs (same trust model as every other source_url this pipeline
// downloads elsewhere in this file).
app.post('/image-compose', async (req, res) => {
  const signature = req.header('X-Signature');
  if (!hmac.verify(env.RENDER_WEBHOOK_SECRET, req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { mode, client_id } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-imgcompose-'));
  try {
    const outPath = path.join(workDir, 'output.png');
    if (mode === 'watermark') {
      const { image_url, logo_url, position } = req.body;
      if (!image_url || !logo_url) return res.status(400).json({ error: 'image_url and logo_url required' });
      const basePath = path.join(workDir, 'base.png'), logoPath = path.join(workDir, 'logo.png');
      await downloadToFile(image_url, basePath);
      await downloadToFile(logo_url, logoPath);
      await watermarkLogo({ basePath, logoPath, outPath, position });
    } else if (mode === 'composite-background') {
      const { cutout_url, color } = req.body;
      if (!cutout_url) return res.status(400).json({ error: 'cutout_url required' });
      const cutoutPath = path.join(workDir, 'cutout.png');
      await downloadToFile(cutout_url, cutoutPath);
      await compositeOnColor({ cutoutPath, outPath, colorHex: color });
    } else if (mode === 'text-overlay') {
      const { image_url, headline, subtext, text_color, box_color, position } = req.body;
      if (!image_url) return res.status(400).json({ error: 'image_url required' });
      if (!headline && !subtext) return res.status(400).json({ error: 'headline or subtext required' });
      const basePath = path.join(workDir, 'base.png');
      await downloadToFile(image_url, basePath);
      await textOverlay({ basePath, outPath, headline, subtext, textColor: text_color, boxColor: box_color, position });
    } else if (mode === 'reframe') {
      const { image_url, aspect } = req.body;
      if (!image_url || !aspect) return res.status(400).json({ error: 'image_url and aspect required' });
      const basePath = path.join(workDir, 'base.png');
      await downloadToFile(image_url, basePath);
      await reframeToAspect({ basePath, outPath, aspect });
    } else {
      return res.status(400).json({ error: `Unknown mode: ${mode}` });
    }
    const key = `marketing/${client_id}/images/${Date.now()}-${mode}.png`;
    const result = await uploadOutput(env, outPath, key, 'image/png');
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('image-compose failed:', err.stderr || err.message || err);
    res.status(502).json({ error: String(err.message || err).slice(0, 500) });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// Also synchronous, same reasoning as /detect-scenes above — espeak-ng synthesis is fast (well
// under real-time even for a full script), so there's no need for the async job queue the actual
// video render uses. See lib/tts.js for what this is and isn't (genuinely free/local, but
// robotic-sounding — not a paid neural voice).
app.post('/synthesize-voiceover', async (req, res) => {
  const signature = req.header('X-Signature');
  if (!hmac.verify(env.RENDER_WEBHOOK_SECRET, req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { text, language, client_id, project_id } = req.body || {};
  if (!text || !client_id || !project_id) return res.status(400).json({ error: 'text, client_id and project_id required' });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-tts-'));
  try {
    const localPath = path.join(workDir, 'voiceover.mp3');
    await synthesizeVoiceover(text, language, localPath);
    const key = `marketing/${client_id}/${project_id}/voiceover-${Date.now()}.mp3`;
    const result = await uploadOutput(env, localPath, key, 'audio/mpeg');
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('synthesize-voiceover failed:', err.stderr || err.message || err);
    res.status(502).json({ error: String(err.message || err).slice(0, 500) });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// Synchronous, not queued — same reasoning as /synthesize-voiceover above. This is the STANDBY
// text-to-speech provider for the WhatsApp voice-to-voice reply feature: Sarvam AI
// (cloudflare-worker/worker.js's engineSarvamTts) stays the PRIMARY provider everywhere and is
// called directly from the Worker, never routed through here — this endpoint only exists so the
// Worker (and backend/recovery.js's automated recovery ladder) have something to fall back to
// when Sarvam's call already failed or SARVAM_API_KEY isn't configured, so a customer still gets
// a real voice-note reply instead of silently downgrading straight to text. Gated behind
// AI4BHARAT_TTS_ENABLED (opt-in, off by default) since this loads a real PyTorch model — see
// lib/ai4bharatTts.js and tts/synthesize_ai4bharat.py for what is and isn't verified about it.
// Returns raw audio/ogg bytes (like /extract-audio returns raw audio/mpeg) rather than uploading
// to R2 — this is a live chat reply, not a stored render asset.
app.post('/synthesize-voice-reply', async (req, res) => {
  const signature = req.header('X-Signature');
  if (!hmac.verify(env.RENDER_WEBHOOK_SECRET, req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (!env.AI4BHARAT_TTS_ENABLED) return res.status(503).json({ error: 'AI4BHARAT_TTS_ENABLED is not set on the render pipeline.' });
  const { text, language } = req.body || {};
  if (!text || !language) return res.status(400).json({ error: 'text and language required' });
  if (!ai4bharatTtsSupportsLanguage(language)) return res.status(400).json({ error: `Unsupported language for AI4Bharat TTS: ${language}` });
  if (!ai4bharatLiveSemaphore.tryAcquire()) {
    res.set('Retry-After', '1');
    return res.status(429).json({ error: 'AI4Bharat TTS is busy; use the configured fallback provider.' });
  }
  try {
    const audioBuf = await synthesizeWithAi4Bharat(text, language);
    res.set('Content-Type', 'audio/ogg');
    res.send(audioBuf);
  } catch (err) {
    console.error('synthesize-voice-reply failed:', err.stderr || err.message || err);
    res.status(502).json({ error: String(err.message || err).slice(0, 500) });
  } finally {
    ai4bharatLiveSemaphore.release();
  }
});

// Synchronous, not queued — same reasoning as /synthesize-voice-reply above. Piper TTS
// (CLIENTS.voice_tts_provider==='piper', see worker.js's engineTtsWithFallback) — a free, fully
// local, always-available provider (no PyTorch, no opt-in env var needed, unlike AI4Bharat above)
// baked into this image's Dockerfile. Not gated behind an enable flag: unlike AI4Bharat's ~1.2GB
// torch stack, Piper is a small binary + one small voice model with no meaningful resource cost to
// leave available — the real gate is per-language voice coverage (piperSupportsLanguage), not
// whether the feature is turned on at all.
app.post('/synthesize-piper-tts', async (req, res) => {
  const signature = req.header('X-Signature');
  if (!hmac.verify(env.RENDER_WEBHOOK_SECRET, req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { text, language } = req.body || {};
  if (!text || !language) return res.status(400).json({ error: 'text and language required' });
  if (!piperSupportsLanguage(language)) return res.status(400).json({ error: `No Piper voice available for language: ${language}` });
  try {
    const audioBuf = await synthesizeWithPiper(text, language);
    res.set('Content-Type', 'audio/ogg');
    res.send(audioBuf);
  } catch (err) {
    console.error('synthesize-piper-tts failed:', err.stderr || err.message || err);
    res.status(502).json({ error: String(err.message || err).slice(0, 500) });
  }
});

// Synchronous, not queued — same reasoning as /synthesize-voice-reply above. This is the OPTIONAL
// Gemini Live provider for the WhatsApp voice-to-voice reply feature (CLIENTS.voice_tts_provider
// === 'gemini_live', see worker.js's engineTtsWithFallback): the Worker opens the Live API
// WebSocket itself and gets back raw PCM16 audio (Gemini Live's native output format), but
// WhatsApp only renders a native voice-note bubble for Ogg/Opus — ffmpeg does that conversion
// here, mirroring how AI4Bharat TTS's audio already flows through this same service. Stateless and
// model-free (no PyTorch, unlike AI4Bharat above), so this stays enabled by default rather than
// behind its own opt-in env var.
app.post('/pcm-to-ogg', async (req, res) => {
  const signature = req.header('X-Signature');
  if (!hmac.verify(env.RENDER_WEBHOOK_SECRET, req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { pcm_base64, sample_rate, channels } = req.body || {};
  if (!pcm_base64) return res.status(400).json({ error: 'pcm_base64 required' });
  try {
    const pcmBuf = Buffer.from(pcm_base64, 'base64');
    const oggBuf = await pcmToOggOpus(pcmBuf, sample_rate, channels);
    res.set('Content-Type', 'audio/ogg');
    res.send(oggBuf);
  } catch (err) {
    console.error('pcm-to-ogg failed:', err.stderr || err.message || err);
    res.status(502).json({ error: String(err.message || err).slice(0, 500) });
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
      : job.spec?.mode === 'ai-broll'
      ? await generateAiBroll(job, env)
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
