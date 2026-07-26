// Orchestrates one `spec.mode:'caption-clip'` job (see SETUP.md "Marketing Studio module" for
// the full spec/callback contract this implements the other end of). Ties together every module
// in this directory: download -> optional silence detection -> time-remap captions/cues ->
// resolve local B-roll/SFX/music assets -> build the ffmpeg filter graph -> run it -> upload.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { downloadToFile } = require('./download');
const { detectSilence, computeKeepSegments, makeTimeMapper } = require('./timeline');
const { writeAssFile } = require('./subtitles');
const { buildFfmpegArgs } = require('./filtergraph');
const { run } = require('./exec');
const { getDurationSec } = require('./probe');
const { resolveBroll, resolveSfx, resolveMusic } = require('./assets');
const { uploadOutput } = require('./storage');

function parseResolution(res) {
  const m = /^(\d+)x(\d+)$/.exec(res || '');
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : { w: 1080, h: 1920 };
}

async function renderCaptionClip(job, env, assetsRoot) {
  const { spec } = job;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-render-'));
  try {
    const sourcePath = path.join(workDir, 'source' + (path.extname(new URL(spec.source_url).pathname) || '.mp4'));
    await downloadToFile(spec.source_url, sourcePath);

    const trimStart = Number(spec.trim_start_sec) || 0;
    const trimEnd = Number(spec.trim_end_sec) || trimStart + 1;

    let keepSegments;
    if (spec.silence_cut) {
      const silences = await detectSilence(sourcePath, trimStart, trimEnd);
      keepSegments = computeKeepSegments(trimStart, trimEnd, silences);
    } else {
      keepSegments = [{ start: trimStart, end: trimEnd }];
    }
    const remap = makeTimeMapper(keepSegments);

    const words = (spec.captions?.words || []).map(w => ({
      word: w.word,
      start: remap(Number(w.start) || 0),
      end: remap(Number(w.end) || 0),
    }));

    const { w: resolutionW, h: resolutionH } = parseResolution(spec.resolution);

    const acceptedCues = (spec.cues || []).filter(c => c.accepted !== false);
    const broll = [];
    const sfx = [];
    const vfx = [];
    for (const cue of acceptedCues) {
      const start = remap(Number(cue.start) || 0);
      const end = Math.max(start + 0.3, remap(Number(cue.end) || 0));
      if (cue.type === 'broll') {
        const assetPath = resolveBroll(assetsRoot, cue.tag);
        if (assetPath) broll.push({ path: assetPath, startSec: start, endSec: end });
      } else if (cue.type === 'sfx') {
        const assetPath = resolveSfx(assetsRoot, cue.tag);
        if (assetPath) sfx.push({ path: assetPath, atSec: start });
      } else if (cue.type === 'vfx') {
        vfx.push({ type: cue.tag, startSec: start, endSec: end }); // vfx needs no asset — pure filter effect
      }
    }

    let music = null;
    if (spec.background_music) {
      const musicPath = resolveMusic(assetsRoot, spec.background_music);
      if (musicPath) music = { path: musicPath, volume: 0.15 };
    }

    let assPath = null;
    if (words.length) {
      assPath = path.join(workDir, 'captions.ass');
      writeAssFile(assPath, words, spec.style || {}, { resolutionW, resolutionH });
    }

    const outputPath = path.join(workDir, 'output.mp4');
    const args = buildFfmpegArgs({
      inputPath: sourcePath,
      keepSegments,
      resolutionW, resolutionH,
      assPath,
      watermark: !!spec.watermark,
      autoZoom: !!spec.auto_zoom,
      music,
      sfx,
      broll,
      vfx,
      outputPath,
    });
    await run('ffmpeg', args, { timeoutMs: 20 * 60 * 1000 });

    const durationSec = await getDurationSec(outputPath);
    const key = `marketing/${job.client_id}/${job.project_id}/render-${crypto.randomBytes(6).toString('hex')}.mp4`;
    const result = await uploadOutput(env, outputPath, key);
    return { ...result, duration_sec: durationSec };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { renderCaptionClip };
