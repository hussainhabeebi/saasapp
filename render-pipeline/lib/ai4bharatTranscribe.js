// Self-hosted transcription via AI4Bharat's IndicConformer — see asr/transcribe_ai4bharat.py's
// header comment for the full story (why this over whisperX, what's honestly not covered — no
// word-level timestamps, only improved recognized text for Indic languages). Same subprocess
// pattern as every other external tool this pipeline shells out to (ffmpeg, espeak-ng,
// asr/transcribe.py).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { downloadToFile } = require('./download');
const { run } = require('./exec');

// AI4Bharat's IndicConformer covers 22 official Indian languages; this app only exposes the
// subset it already has a language hint for elsewhere (the same set sarvamTranscribe.js's
// SARVAM_LANG_MAP targets) — "hi" was the one confirmed working in the model's own usage example,
// the rest follow the same ISO-639-1-ish convention but were not individually confirmed against a
// live call (that network access is blocked in this dev sandbox — see the .py script's header).
const AI4BHARAT_LANGS = new Set(['hi', 'bn', 'kn', 'ml', 'mr', 'or', 'pa', 'ta', 'te', 'gu']);

function supportsLanguage(language) {
  return AI4BHARAT_LANGS.has((language || '').toLowerCase());
}

function runTranscribeScript(audioPath, language) {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [path.join(__dirname, '..', 'asr', 'transcribe_ai4bharat.py'), audioPath, language],
      { maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').slice(-1000)));
        resolve(stdout);
      }
    );
  });
}

// Single-pass, whole-clip transcription — no chunking/offset arithmetic like sarvamTranscribe.js
// needs (Sarvam's 30s-per-request cap is what forced that in the first place, and the offset math
// around chunk boundaries is the leading suspect for the duplicated/misplaced-word bug that
// motivated adding a self-hosted alternative at all). IndicConformer has no documented per-request
// duration cap, so there's nothing to chunk here.
async function transcribeWithAi4Bharat(sourceUrl, language, env) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-ai4b-'));
  try {
    const srcExt = path.extname(new URL(sourceUrl).pathname) || '.mp4';
    const srcPath = path.join(workDir, 'source' + srcExt);
    await downloadToFile(sourceUrl, srcPath);
    const audioPath = path.join(workDir, 'audio.wav');
    // 16kHz mono WAV — the model's own documented example loads via torchaudio and resamples to
    // 16kHz itself, but doing it here with ffmpeg (already a hard dependency of this whole
    // pipeline) avoids relying on torchaudio's own resampler/codec support for whatever format
    // the source video's audio track happens to be in.
    await run('ffmpeg', ['-y', '-i', srcPath, '-vn', '-ac', '1', '-ar', '16000', audioPath]);

    const stdout = await runTranscribeScript(audioPath, language);
    const lastLine = stdout.trim().split('\n').pop() || '';
    let data;
    try { data = JSON.parse(lastLine); }
    catch (e) { throw new Error('Could not parse AI4Bharat output: ' + stdout.slice(-500)); }
    if (data.error) throw new Error(data.error);
    return data;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { transcribeWithAi4Bharat, supportsLanguage };
