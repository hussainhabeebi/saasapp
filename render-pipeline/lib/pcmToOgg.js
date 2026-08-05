// Converts raw PCM16 audio (Gemini Live API's output format — see worker.js's
// engineGeminiLiveTts) into WhatsApp's native voice-note format: mono 16kHz Ogg/Opus. Same
// reasoning as this file's sibling conversions (extractAudio.js etc.) — ffmpeg isn't available in
// a Cloudflare Worker, so any audio format work happens here instead. The Gemini Live API streams
// back headerless little-endian PCM16 (typically 24kHz mono, per Google's documented output
// format), which ffmpeg can't sniff on its own — sampleRate/channels are passed in explicitly and
// fed to ffmpeg's `-f s16le` raw-audio demuxer rather than relying on autodetection.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run } = require('./exec');

async function pcmToOggOpus(pcmBuf, sampleRate, channels) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-pcm-'));
  try {
    const inPath = path.join(workDir, 'in.pcm');
    const outPath = path.join(workDir, 'out.ogg');
    fs.writeFileSync(inPath, pcmBuf);
    await run('ffmpeg', [
      '-y',
      '-f', 's16le', '-ar', String(sampleRate || 24000), '-ac', String(channels || 1), '-i', inPath,
      '-ac', '1', '-ar', '16000', '-c:a', 'libopus',
      outPath,
    ]);
    return fs.readFileSync(outPath);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { pcmToOggOpus };
