// Extracts just the audio track from a video — used by /extract-audio (server.js) so the Worker
// can send a MUCH smaller file to the transcription API than the full video. Real fix for a real
// bug: OpenAI's Whisper endpoint hard-caps requests at 25 MB, and a video's picture data usually
// dwarfs its audio data, so a video comfortably under the Worker's own 100 MB upload ceiling can
// still fail transcription with a 413 purely because it's a *video* file, not because the actual
// speech content is large. 16kHz mono 64kbps is plenty for speech transcription (Whisper itself
// resamples to 16kHz internally regardless of what's fed in) while keeping the extracted file
// tiny — even a long video's audio track alone rarely approaches 25 MB at this bitrate.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { downloadToFile } = require('./download');
const { run } = require('./exec');

async function extractAudio(sourceUrl) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-audio-'));
  try {
    const srcExt = path.extname(new URL(sourceUrl).pathname) || '.mp4';
    const srcPath = path.join(workDir, 'source' + srcExt);
    await downloadToFile(sourceUrl, srcPath);
    const outPath = path.join(workDir, 'audio.mp3');
    await run('ffmpeg', ['-y', '-i', srcPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', outPath]);
    return fs.readFileSync(outPath);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { extractAudio };
