// Dedicated voice service retained from the former Marketing Studio render pipeline.
// The public base URL and HMAC secret stay compatible with existing Worker/recovery settings.
require('dotenv').config();

const fs = require('fs');
const express = require('express');
const hmac = require('./lib/hmac');
const {
  synthesizeWithAi4Bharat,
  supportsLanguage: ai4bharatSupportsLanguage,
  preloadAi4Bharat,
  isAi4BharatReady,
} = require('./lib/ai4bharatTts');
const { synthesizeWithPiper, supportsLanguage: piperSupportsLanguage, PIPER_VOICE_MAP } = require('./lib/piperTts');
const { pcmToOggOpus } = require('./lib/pcmToOgg');
const { createLiveSemaphore } = require('./lib/liveSemaphore');

const BUILD_TAG = '2026-09-06-voice-only';
const env = process.env;
const PORT = env.PORT || 8787;
const ai4bharatLiveSemaphore = createLiveSemaphore(2);
const ai4bharatInstalled = env.AI4BHARAT_TTS_INSTALLED === 'true';
const ai4bharatEnabled = ai4bharatInstalled && env.AI4BHARAT_TTS_ENABLED === 'true';

if (!env.RENDER_WEBHOOK_SECRET) {
  console.error('RENDER_WEBHOOK_SECRET is not set. Refusing to start.');
  process.exit(1);
}

const app = express();
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

function requireSignature(req, res) {
  if (hmac.verify(env.RENDER_WEBHOOK_SECRET, req.rawBody, req.header('X-Signature'))) return true;
  res.status(401).json({ error: 'Invalid signature' });
  return false;
}

app.get('/health', (_req, res) => {
  const piperBin = env.PIPER_BIN || '/opt/piper/piper';
  res.json({
    ok: true,
    service: 'leadvyne-voice',
    build: BUILD_TAG,
    ai4bharat_tts_active: ai4bharatLiveSemaphore.active,
    ai4bharat_tts_limit: ai4bharatLiveSemaphore.limit,
    ai4bharat_tts_installed: ai4bharatInstalled,
    ai4bharat_tts_enabled: ai4bharatEnabled,
    ai4bharat_model_ready: isAi4BharatReady(),
    ai4bharat_tts_timeout_ms: Math.max(5000, Number(env.AI4BHARAT_TTS_TIMEOUT_MS || 6500)),
    piper_available: fs.existsSync(piperBin),
    piper_voices: Object.keys(PIPER_VOICE_MAP).filter(language => piperSupportsLanguage(language)),
  });
});

app.post('/synthesize-voice-reply', async (req, res) => {
  if (!requireSignature(req, res)) return;
  if (!ai4bharatEnabled) return res.status(503).json({ error: 'AI4Bharat TTS is not installed and enabled.' });
  const { text, language } = req.body || {};
  if (!text || !language) return res.status(400).json({ error: 'text and language required' });
  if (!ai4bharatSupportsLanguage(language)) return res.status(400).json({ error: `Unsupported language: ${language}` });
  if (!ai4bharatLiveSemaphore.tryAcquire()) {
    res.set('Retry-After', '1');
    return res.status(429).json({ error: 'AI4Bharat TTS is busy; use the configured fallback.' });
  }
  try {
    const audio = await synthesizeWithAi4Bharat(text, language);
    res.type('audio/ogg').send(audio);
  } catch (err) {
    console.error('AI4Bharat synthesis failed:', err.message || err);
    res.status(502).json({ error: String(err.message || err).slice(0, 500) });
  } finally {
    ai4bharatLiveSemaphore.release();
  }
});

app.post('/synthesize-piper-tts', async (req, res) => {
  if (!requireSignature(req, res)) return;
  const { text, language } = req.body || {};
  if (!text || !language) return res.status(400).json({ error: 'text and language required' });
  if (!piperSupportsLanguage(language)) return res.status(400).json({ error: `Unsupported language: ${language}` });
  try {
    const audio = await synthesizeWithPiper(text, language);
    res.type('audio/ogg').send(audio);
  } catch (err) {
    console.error('Piper synthesis failed:', err.message || err);
    res.status(502).json({ error: String(err.message || err).slice(0, 500) });
  }
});

app.post('/pcm-to-ogg', async (req, res) => {
  if (!requireSignature(req, res)) return;
  const { pcm_base64, sample_rate, channels } = req.body || {};
  if (!pcm_base64) return res.status(400).json({ error: 'pcm_base64 required' });
  try {
    const audio = await pcmToOggOpus(Buffer.from(pcm_base64, 'base64'), Number(sample_rate) || 24000, Number(channels) || 1);
    res.type('audio/ogg').send(audio);
  } catch (err) {
    console.error('PCM conversion failed:', err.message || err);
    res.status(502).json({ error: String(err.message || err).slice(0, 500) });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Voice endpoint not found' }));

app.listen(PORT, () => {
  console.log(`LeadVyne voice service listening on :${PORT}`);
  if (ai4bharatEnabled) {
    preloadAi4Bharat()
      .then(info => console.log(`AI4Bharat model ready on ${info.device}`))
      .catch(error => console.error('AI4Bharat preload failed:', error.message));
  }
});
