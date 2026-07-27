// Self-hosted transcription via faster-whisper (CTranslate2-backed Whisper) — see
// asr/transcribe.py's header comment for the full story of why this replaced the originally-
// requested "whisperX" (m-bain/whisperX) package: whisperX's own dependency chain failed to
// install in testing (antlr4-python3-runtime, pulled in transitively via pyannote.audio for
// speaker diarization — a feature this app doesn't use), and its actual differentiator
// (per-language wav2vec2 forced alignment) doesn't clearly cover Tamil/Malayalam anyway —
// AI4Bharat's IndicWav2Vec models were confirmed to exist for Hindi/Odia/Bengali/Telugu, NOT
// confirmed for Tamil/Malayalam specifically. faster-whisper's own built-in `word_timestamps`
// covers every Whisper language uniformly, which is the real substance of what was asked for.
//
// Entirely opt-in (env.WHISPER_LOCAL_ENABLED) — this is a genuinely heavier dependency than
// anything else in this pipeline (a real Python ML stack, not just another subprocess binary like
// ffmpeg/espeak-ng), so it doesn't change behavior for anyone who hasn't explicitly turned it on.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { downloadToFile } = require('./download');
const { run } = require('./exec');

function runTranscribeScript(audioPath, language, modelSize) {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [path.join(__dirname, '..', 'asr', 'transcribe.py'), audioPath, language || 'auto', modelSize],
      { maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').slice(-1000)));
        resolve(stdout);
      }
    );
  });
}

// Same download+extract-audio shape as sarvamTranscribe.js (own temp dir, own ffmpeg pass) rather
// than reusing lib/extractAudio.js — that helper returns a Buffer for a multipart upload; this
// needs an actual file path on disk to hand to the Python subprocess, and cleans it up itself.
async function transcribeWithWhisperLocal(sourceUrl, language, env) {
  const modelSize = env.WHISPER_MODEL_SIZE || 'small'; // CPU-friendly default — see SETUP.md for the speed/accuracy tradeoff of larger sizes
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-whisper-'));
  try {
    const srcExt = path.extname(new URL(sourceUrl).pathname) || '.mp4';
    const srcPath = path.join(workDir, 'source' + srcExt);
    await downloadToFile(sourceUrl, srcPath);
    const audioPath = path.join(workDir, 'audio.mp3');
    await run('ffmpeg', ['-y', '-i', srcPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audioPath]);

    const stdout = await runTranscribeScript(audioPath, language, modelSize);
    const lastLine = stdout.trim().split('\n').pop() || '';
    let data;
    try { data = JSON.parse(lastLine); }
    catch (e) { throw new Error('Could not parse local Whisper output: ' + stdout.slice(-500)); }
    if (data.error) throw new Error(data.error);
    return data;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { transcribeWithWhisperLocal };
