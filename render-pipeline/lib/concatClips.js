// Stitches several uploaded video clips into one combined video — POST /concat-clips
// (server.js), called once by the Worker when a multi-clip project is "combined" into a single
// source (see marketing_project_clips in the D1 schema). After this runs, the combined output is
// just an ordinary project source video — the existing transcribe/caption/render pipeline never
// needs to know a project started out as several separate clips.
//
// Each clip is normalized (scaled/cropped to the target resolution) before concatenating, via
// the filter_complex `concat` filter (re-encodes) rather than the `concat` demuxer (stream-copy) —
// uploaded clips can come from different cameras/apps with different resolutions/codecs/frame
// rates, and stream-copy concat requires those to already match. Same trim+concat filter shape as
// buildFfmpegArgs's silence-cut segments (lib/filtergraph.js), just concatenating whole clips
// instead of sub-segments of one clip.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { downloadToFile } = require('./download');
const { run } = require('./exec');
const { getDurationSec } = require('./probe');
const { uploadOutput } = require('./storage');

function parseResolution(res) {
  const m = /^(\d+)x(\d+)$/.exec(res || '');
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : { w: 1080, h: 1920 };
}

async function concatClips(env, sourceUrls, resolution, clientId, projectId) {
  if (!Array.isArray(sourceUrls) || sourceUrls.length < 1) throw new Error('source_urls (a non-empty array) required');
  const { w, h } = parseResolution(resolution);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-concat-'));
  try {
    const clipPaths = [];
    for (let i = 0; i < sourceUrls.length; i++) {
      const ext = path.extname(new URL(sourceUrls[i]).pathname) || '.mp4';
      const p = path.join(workDir, `clip-${i}${ext}`);
      await downloadToFile(sourceUrls[i], p);
      clipPaths.push(p);
    }

    // Single clip: no concat needed, just normalize resolution/codec so the output is
    // consistent with what a multi-clip combine would have produced.
    const filters = [];
    const inputs = [];
    clipPaths.forEach((p, i) => {
      inputs.push('-i', p);
      filters.push(`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=30[cv${i}]`);
      filters.push(`[${i}:a]aresample=44100,asetpts=PTS-STARTPTS[ca${i}]`);
    });
    const concatIn = clipPaths.map((_, i) => `[cv${i}][ca${i}]`).join('');
    filters.push(`${concatIn}concat=n=${clipPaths.length}:v=1:a=1[vout][aout]`);

    const outputPath = path.join(workDir, 'combined.mp4');
    await run('ffmpeg', [
      '-y', ...inputs,
      '-filter_complex', filters.join('; '),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      outputPath,
    ], { timeoutMs: 20 * 60 * 1000 });

    const durationSec = await getDurationSec(outputPath);
    const key = `marketing/${clientId}/${projectId}/combined-${crypto.randomBytes(6).toString('hex')}.mp4`;
    const result = await uploadOutput(env, outputPath, key);
    return { ...result, duration_sec: durationSec };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { concatClips };
