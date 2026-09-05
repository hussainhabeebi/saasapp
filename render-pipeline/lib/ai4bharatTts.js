// Self-hosted text-to-speech STANDBY via AI4Bharat's Indic Parler-TTS — see
// tts/synthesize_ai4bharat.py's header comment for the full story (what's confirmed vs. guessed
// about the model, the per-language description-prompt approach, the CPU-latency tradeoff). This
// is the STANDBY provider for the WhatsApp voice-to-voice reply feature:
// cloudflare-worker/worker.js's engineSarvamTts stays PRIMARY everywhere — this only runs when
// that call already failed or SARVAM_API_KEY isn't configured (see engineTtsWithFallback in
// worker.js, and backend/recovery.js's ported copy for the automated recovery ladder).
//
// Same subprocess pattern as lib/ai4bharatTranscribe.js (own temp dir, execFile python3, JSON on
// the last stdout line) plus one extra step transcription doesn't need: converting the model's
// raw WAV output to 16kHz Ogg/Opus so the result is byte-for-byte interchangeable with
// engineSarvamTts's own output_audio_codec:'opus'/speech_sample_rate:16000 contract — the Worker,
// recovery.js, and the Chatwoot-attachment code that consumes this never need to know which
// provider produced it.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { run } = require('./exec');

// Same scope as ai4bharatTranscribe.js's AI4BHARAT_LANGS — this app only has a reason to route
// the languages it already maps elsewhere (Sarvam's ENGINE_TTS_LANG_MAP in worker.js), not Indic
// Parler-TTS's full ~21-language coverage.
const AI4BHARAT_TTS_LANGS = new Set(['hi', 'bn', 'kn', 'ml', 'mr', 'or', 'pa', 'ta', 'te', 'gu', 'en']);

function supportsLanguage(language) {
  return AI4BHARAT_TTS_LANGS.has((language || '').toLowerCase());
}

function runSynthesizeScript(text, language, outputPath) {
  const timeoutMs = Math.max(5000, Number(process.env.AI4BHARAT_TTS_TIMEOUT_MS || 20000));
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [path.join(__dirname, '..', 'tts', 'synthesize_ai4bharat.py'), text, language, outputPath],
      // Live WhatsApp replies cannot wait for the old five-minute subprocess timeout. The Worker
      // hedges to Sarvam after 1.5s; this server-side ceiling protects the VPS even if the client
      // disconnects while Python is still running.
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').slice(-1000)));
        resolve(stdout);
      }
    );
  });
}

// Returns a Buffer of 16kHz Ogg/Opus audio bytes, or throws — the caller (server.js's
// POST /synthesize-voice-reply) is expected to treat any failure the same as Sarvam's own
// failure modes: log it and report "standby unavailable too" rather than crash the request.
async function synthesizeWithAi4Bharat(text, language) {
  if (!text || !text.trim()) throw new Error('No text to synthesize.');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-ai4b-tts-'));
  try {
    const wavPath = path.join(workDir, 'out.wav');
    // Capped at the same 500 chars Sarvam's own TTS call caps at (worker.js's engineSarvamTts) —
    // a voice reply is meant to be one short spoken sentence, never a long paragraph.
    const stdout = await runSynthesizeScript(text.slice(0, 500), language, wavPath);
    const lastLine = stdout.trim().split('\n').pop() || '';
    let meta;
    try { meta = JSON.parse(lastLine); }
    catch (e) { throw new Error('Could not parse AI4Bharat TTS output: ' + stdout.slice(-500)); }
    if (meta.error) throw new Error(meta.error);

    const oggPath = path.join(workDir, 'out.ogg');
    await run('ffmpeg', ['-y', '-i', wavPath, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', oggPath]);
    return fs.readFileSync(oggPath);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { synthesizeWithAi4Bharat, supportsLanguage };
