// "Text behind subject" — the caption sits BEHIND the person instead of on top of the video.
// Built as its own, simpler compositing pipeline rather than bolted onto buildFfmpegArgs
// (lib/filtergraph.js): reordering layers (background+text, THEN person cut out on top) is a
// structurally different filter graph, not a variant of "burn subtitles on top of the video".
// v1 scope: does not combine with silence-cut/auto-zoom/B-roll/SFX/VFX cues in the same render —
// see README.md's known limitations for why (combining the segment-splice machinery those use
// with this layer-reordering would be a substantially bigger rework; this ships the core effect
// people actually ask for first).
const { run } = require('./exec');
const { generateMatte } = require('./segmentation');
const { QUALITY_PRESETS } = require('./filtergraph');

// bgColor: solid color behind the text/person (a later version could support a blurred/frozen
// video background instead — not built, see README).
function buildArgs({ sourcePath, mattePath, matteMeta, resolutionW, resolutionH, fps, assPath, bgColor, watermark, quality, fontsDir, outputPath }) {
  const q = QUALITY_PRESETS[quality] || QUALITY_PRESETS.standard;
  const filters = [
    `[0:v]scale=${resolutionW}:${resolutionH}:force_original_aspect_ratio=increase,crop=${resolutionW}:${resolutionH}[src]`,
    `[1:v]scale=${resolutionW}:${resolutionH}:flags=lanczos,fps=${fps}[matte]`,
    `[src][matte]alphamerge[person]`,
    `color=c=${(bgColor || '#0A0A14').replace('#', '0x')}:s=${resolutionW}x${resolutionH}:d=9999[bg]`,
  ];
  let bgChain = 'bg';
  if (assPath) {
    // Same fontsdir mechanism as the main pipeline (lib/filtergraph.js) — custom caption fonts
    // (fonts/README.md) work here too, not just the on-top-of-video burn-in path.
    const escPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');
    const fontsdirClause = fontsDir ? `:fontsdir='${escPath(fontsDir)}'` : '';
    filters.push(`[${bgChain}]subtitles=${escPath(assPath)}${fontsdirClause}[bgtext]`);
    bgChain = 'bgtext';
  }
  filters.push(`[${bgChain}][person]overlay=shortest=1[vcomp]`);
  let vChain = 'vcomp';
  if (watermark) {
    filters.push(`[${vChain}]drawtext=text='Made with Leadvyne':fontcolor=white@0.75:fontsize=${Math.round(resolutionH * 0.022)}:x=w-tw-24:y=h-th-24:shadowcolor=black@0.6:shadowx=2:shadowy=2[vout]`);
    vChain = 'vout';
  } else {
    filters.push(`[${vChain}]null[vout]`);
    vChain = 'vout';
  }

  return [
    '-y', '-i', sourcePath, '-i', mattePath,
    '-filter_complex', filters.join('; '),
    '-map', `[${vChain}]`, '-map', '0:a',
    '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf),
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    '-shortest',
    outputPath,
  ];
}

// sourcePath must already be trimmed to the exact clip being rendered (matting runs on exactly
// what will be shown — no separate trim step here, unlike the caption-clip pipeline's silence-cut
// segments).
async function renderTextBehindSubject({ sourcePath, resolutionW, resolutionH, fps = 30, assPath, bgColor, watermark, quality, fontsDir, outputPath }, mattePath) {
  const matteMeta = await generateMatte(sourcePath, mattePath, resolutionW / resolutionH);
  const args = buildArgs({ sourcePath, mattePath, matteMeta, resolutionW, resolutionH, fps, assPath, bgColor, watermark, quality, fontsDir, outputPath });
  await run('ffmpeg', args, { timeoutMs: 20 * 60 * 1000 });
  return outputPath;
}

module.exports = { renderTextBehindSubject, buildArgs };
