// Free, fully local, fully offline neural TTS via Piper (rhasspy/piper, MIT-licensed binary) — a
// genuinely free alternative to Sarvam/AI4Bharat/Gemini Live: no API key, no per-request cost, no
// PyTorch (~50-100MB total for the binary + one voice model, vs. AI4Bharat TTS's ~1.2GB torch
// stack). Sounds noticeably better than lib/tts.js's espeak-ng (a real neural voice, not a
// formant synthesizer) but isn't a drop-in replacement for Sarvam's quality either — documented
// tradeoff, same as every other TTS option in this file.
//
// This is an EXPLICIT OPT-IN provider (cloudflare-worker/worker.js's engineTtsWithFallback,
// CLIENTS.voice_tts_provider==='piper'), same treatment as gemini_live — never an automatic
// fallback. Reason: language coverage is the real limitation. Only en_US-lessac-medium (Piper's
// own canonical quickstart voice) is baked into the Docker image by default — see the Dockerfile
// for how to add more voices. PIPER_VOICE_MAP below is intentionally small and overridable via the
// PIPER_VOICE_MAP_JSON env var rather than guessing at Piper voice-model filenames for languages
// this app targets (Malayalam/Tamil/Telugu/etc.) that were NOT independently confirmed to exist as
// published Piper voices — an unconfirmed guess here would silently 404 at runtime, which is worse
// than just being honest that only English is wired up out of the box.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { run } = require('./exec');

const PIPER_BIN = process.env.PIPER_BIN || '/opt/piper/piper';
const PIPER_VOICES_DIR = process.env.PIPER_VOICES_DIR || path.join(__dirname, '..', 'models', 'piper-voices');

// language code -> Piper voice model basename (without .onnx/.onnx.json extension). Extend via
// PIPER_VOICE_MAP_JSON (a {"<lang>":"<voice_basename>"} JSON object env var) once you've downloaded
// additional voice models into PIPER_VOICES_DIR — see Dockerfile / SETUP.md "Piper TTS".
let PIPER_VOICE_MAP = { en: 'en_US-lessac-medium' };
if (process.env.PIPER_VOICE_MAP_JSON) {
  try { PIPER_VOICE_MAP = { ...PIPER_VOICE_MAP, ...JSON.parse(process.env.PIPER_VOICE_MAP_JSON) }; }
  catch (e) { console.error('[piperTts] PIPER_VOICE_MAP_JSON is not valid JSON, ignoring:', e.message); }
}

function supportsLanguage(language) {
  const voice = PIPER_VOICE_MAP[(language || '').toLowerCase()];
  return !!voice && fs.existsSync(path.join(PIPER_VOICES_DIR, voice + '.onnx'));
}

function runPiper(text, modelPath, outWavPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(PIPER_BIN, ['--model', modelPath, '--output_file', outWavPath], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`piper exited ${code}: ${stderr.slice(-500)}`));
      resolve();
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

// Returns a Buffer of 16kHz Ogg/Opus audio bytes (same contract as engineSarvamTts's
// output_audio_codec:'opus'/speech_sample_rate:16000, and synthesizeWithAi4Bharat above) — the
// Worker/backend/recovery.js never need to know which provider produced the audio.
async function synthesizeWithPiper(text, language) {
  if (!text || !text.trim()) throw new Error('No text to synthesize.');
  const voice = PIPER_VOICE_MAP[(language || '').toLowerCase()];
  if (!voice) throw new Error(`No Piper voice configured for language: ${language}`);
  const modelPath = path.join(PIPER_VOICES_DIR, voice + '.onnx');
  if (!fs.existsSync(modelPath)) throw new Error(`Piper voice model not found on disk: ${modelPath} (see Dockerfile / SETUP.md "Piper TTS")`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-piper-tts-'));
  try {
    const wavPath = path.join(workDir, 'out.wav');
    // Same 500-char cap as every other voice-reply provider in this file — a voice reply is one
    // short spoken sentence, never a long paragraph.
    await runPiper(text.slice(0, 500), modelPath, wavPath);
    const oggPath = path.join(workDir, 'out.ogg');
    await run('ffmpeg', ['-y', '-i', wavPath, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', oggPath]);
    return fs.readFileSync(oggPath);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { synthesizeWithPiper, supportsLanguage, PIPER_VOICE_MAP };
