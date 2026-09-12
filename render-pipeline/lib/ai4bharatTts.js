// Persistent AI4Bharat TTS bridge. One Python process owns one loaded model for the lifetime of
// the Coolify container; requests no longer spawn Python and reload several gigabytes of weights.
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { run } = require('./exec');

const LANGUAGES = new Set(['hi', 'bn', 'kn', 'ml', 'mr', 'or', 'pa', 'ta', 'te', 'gu', 'en']);
const SCRIPT = path.join(__dirname, '..', 'tts', 'synthesize_ai4bharat.py');

let child = null;
let readyPromise = null;
let readyState = false;
let pending = new Map();
let retryAfterMs = 0;

function supportsLanguage(language) {
  return LANGUAGES.has((language || '').toLowerCase());
}

function rejectAll(error) {
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(error);
  }
  pending = new Map();
}

function stopWorker(error) {
  const previous = child;
  child = null;
  readyPromise = null;
  readyState = false;
  if (previous && !previous.killed) previous.kill('SIGKILL');
  rejectAll(error || new Error('AI4Bharat worker stopped'));
}

function ensureWorker() {
  if (child && readyPromise) return readyPromise;
  if (Date.now() < retryAfterMs) {
    return Promise.reject(new Error(`AI4Bharat restart cooling down for ${Math.ceil((retryAfterMs - Date.now()) / 1000)}s`));
  }
  readyPromise = new Promise((resolve, reject) => {
    const proc = spawn('python3', [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    let settled = false;
    // VITS worker emits {ready} immediately — 30 s is generous; Parler-TTS needed 180 s.
    const startupTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('AI4Bharat model startup timed out'));
        stopWorker(new Error('AI4Bharat model startup timed out'));
      }
    }, Math.max(10000, Number(process.env.AI4BHARAT_STARTUP_TIMEOUT_MS || 30000)));

    readline.createInterface({ input: proc.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch (_) { return; }
      if (Object.prototype.hasOwnProperty.call(message, 'ready')) {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        if (message.ready) {
          readyState = true;
          resolve(message);
        } else {
          reject(new Error(message.error || 'AI4Bharat model failed to load'));
          stopWorker(new Error(message.error || 'AI4Bharat model failed to load'));
        }
        return;
      }
      const job = pending.get(message.id);
      if (!job) return;
      pending.delete(message.id);
      clearTimeout(job.timer);
      if (message.ok) job.resolve(message);
      else job.reject(new Error(message.error || 'AI4Bharat synthesis failed'));
    });

    proc.stderr.on('data', data => console.error('[ai4bharat]', String(data).trim()));
    proc.on('error', error => {
      if (!settled) { settled = true; clearTimeout(startupTimer); reject(error); }
      stopWorker(error);
    });
    proc.on('exit', (code, signal) => {
      const error = new Error(`AI4Bharat worker exited (${signal || code})`);
      if (!settled) { settled = true; clearTimeout(startupTimer); reject(error); }
      if (child === proc) stopWorker(error);
    });
  });
  return readyPromise;
}

async function requestWav(text, language, outputPath) {
  await ensureWorker();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = null; // No synthesis timeout — VITS on CPU runs until complete.
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, text: text.slice(0, 500), language, output_path: outputPath }) + '\n');
  });
}

async function synthesizeWithAi4Bharat(text, language) {
  if (!text || !text.trim()) throw new Error('No text to synthesize');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-ai4b-'));
  try {
    const wavPath = path.join(workDir, 'out.wav');
    await requestWav(text.trim(), language, wavPath);
    const oggPath = path.join(workDir, 'out.ogg');
    await run('ffmpeg', ['-y', '-i', wavPath, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', oggPath], { timeoutMs: 15000 });
    return fs.readFileSync(oggPath);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function preloadAi4Bharat() {
  return ensureWorker();
}

function isAi4BharatReady() {
  return readyState;
}

module.exports = { synthesizeWithAi4Bharat, supportsLanguage, preloadAi4Bharat, isAi4BharatReady };
