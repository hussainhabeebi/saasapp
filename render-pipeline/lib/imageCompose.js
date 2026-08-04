// Deterministic (no-AI) still-image compositing for the Marketing Studio Image Studio module —
// ffmpeg treats a static image as a one-frame video, so the SAME binary this pipeline already
// runs for every other module (no new dependency, no new container capability) can watermark a
// logo, drop a cutout onto a brand-color background, or burn in a headline/subtext, all as a
// single bounded ffmpeg pass. This exists specifically so those three operations don't need to go
// through fal.ai (paid, and worse at *precise* pixel placement than a plain overlay filter) —
// fal.ai stays reserved for the generative work only an ML model can actually do (text-to-image,
// background *removal*, restyling).
// NOT verified against a live ffmpeg build in this sandbox (no way to run/inspect output here) —
// every filter used below (overlay, color source, drawtext+textfile) is documented, ordinary
// ffmpeg functionality with no exotic flags; each function's job is one bounded ffmpeg call whose
// stderr is passed straight through via lib/exec.js's existing error surfacing (same as every
// other module here), so a wrong filter argument fails loud and readable, not silently.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run } = require('./exec');
const { getVideoDimensions } = require('./probe');

const POSITION_XY = {
  'bottom-right': (pad) => ({ x: `W-w-${pad}`, y: `H-h-${pad}` }),
  'bottom-left': (pad) => ({ x: `${pad}`, y: `H-h-${pad}` }),
  'top-right': (pad) => ({ x: `W-w-${pad}`, y: `${pad}` }),
  'top-left': (pad) => ({ x: `${pad}`, y: `${pad}` }),
  'center': () => ({ x: '(W-w)/2', y: '(H-h)/2' }),
};

// Logo scaled to a fixed % of the BASE image's width (not the logo's own native size, which could
// be anything from a tiny favicon to a huge export) so it reads consistently across different
// source photos — computed here in JS (via ffprobe) rather than in the filtergraph, since
// ffmpeg's overlay filter has no clean way to reference "the OTHER input's width" mid-graph.
async function watermarkLogo({ basePath, logoPath, outPath, position = 'bottom-right', widthPercent = 16, paddingPx = 24 }) {
  const dims = await getVideoDimensions(basePath);
  if (!dims) throw new Error('Could not read the base image dimensions.');
  const logoW = Math.max(24, Math.round(dims.width * (widthPercent / 100)));
  const { x, y } = (POSITION_XY[position] || POSITION_XY['bottom-right'])(paddingPx);
  await run('ffmpeg', [
    '-y', '-i', basePath, '-i', logoPath,
    '-filter_complex', `[1:v]scale=${logoW}:-1[logo];[0:v][logo]overlay=${x}:${y}:format=auto`,
    '-frames:v', '1', '-update', '1', outPath,
  ]);
  return outPath;
}

// Puts a (typically transparent-background) cutout onto a solid brand-color backdrop sized to
// match the cutout exactly — a plain color source + overlay, not a generative call, since "put
// this on a flat color" needs no ML once the subject is already isolated (that isolation step is
// lib/... no — that's fal's background-removal model, called by the Worker; this function only
// does the deterministic half).
async function compositeOnColor({ cutoutPath, outPath, colorHex = '#FFFFFF' }) {
  const dims = await getVideoDimensions(cutoutPath);
  if (!dims) throw new Error('Could not read the cutout image dimensions.');
  const hex = /^#?[0-9a-fA-F]{6}$/.test(colorHex) ? colorHex.replace('#', '') : 'FFFFFF';
  await run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=${dims.width}x${dims.height}`,
    '-i', cutoutPath,
    '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto',
    '-frames:v', '1', '-update', '1', outPath,
  ]);
  return outPath;
}

// Burns in a headline + optional subtext, e.g. "Sale 20% Off" style announcement graphics —
// diffusion image models are notoriously unreliable at rendering legible in-image text, so this
// is the deterministic alternative for exactly that case. Text is written to temp .txt files and
// referenced via drawtext's `textfile=` option rather than embedded directly in the filter-graph
// string — sidesteps ffmpeg filtergraph string-escaping entirely (colons/quotes/percent signs in
// a caption would otherwise have to be hand-escaped for drawtext's `text=` syntax, a well-known
// source of subtle bugs), since only the temp file's own path (which this function controls, not
// the caller) ends up in the filter string.
async function textOverlay({ basePath, outPath, headline, subtext, textColor = '#FFFFFF', boxColor = 'black@0.45', position = 'bottom' }) {
  const dims = await getVideoDimensions(basePath);
  if (!dims) throw new Error('Could not read the base image dimensions.');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-textoverlay-'));
  try {
    const headlineSize = Math.round(dims.width * 0.075);
    const subtextSize = Math.round(dims.width * 0.04);
    const yBase = position === 'top' ? Math.round(dims.height * 0.08)
      : position === 'center' ? Math.round(dims.height * 0.42)
      : Math.round(dims.height * 0.72); // 'bottom' (default)
    const filters = [];
    if (headline) {
      const p = path.join(workDir, 'headline.txt');
      fs.writeFileSync(p, String(headline).slice(0, 200));
      filters.push(`drawtext=textfile='${p}':fontcolor=${textColor}:fontsize=${headlineSize}:font='Sans Bold':x=(w-text_w)/2:y=${yBase}:box=1:boxcolor=${boxColor}:boxborderw=18`);
    }
    if (subtext) {
      const p = path.join(workDir, 'subtext.txt');
      fs.writeFileSync(p, String(subtext).slice(0, 300));
      filters.push(`drawtext=textfile='${p}':fontcolor=${textColor}:fontsize=${subtextSize}:font='Sans':x=(w-text_w)/2:y=${yBase}+${Math.round(headlineSize * 1.4)}:box=1:boxcolor=${boxColor}:boxborderw=14`);
    }
    if (!filters.length) throw new Error('headline or subtext required.');
    await run('ffmpeg', ['-y', '-i', basePath, '-vf', filters.join(','), '-frames:v', '1', '-update', '1', outPath]);
    return outPath;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const ASPECT_RATIOS = { '1:1': 1, '4:5': 4 / 5, '9:16': 9 / 16, '16:9': 16 / 9 };

// "Multi-aspect from one generation" — a center crop to a different platform aspect ratio (feed
// vs story/reel cover vs landscape) instead of paying for a second fal.ai generation just to get a
// different shape of the same image. Deterministic and free, same reasoning as every other
// function in this file. Always crops (never pads/letterboxes) — simplest correct behavior, and
// matches how Instagram's own feed/story previews already crop a shared source image.
async function reframeToAspect({ basePath, outPath, aspect }) {
  const targetRatio = ASPECT_RATIOS[aspect];
  if (!targetRatio) throw new Error(`Unknown aspect ratio: ${aspect}`);
  const dims = await getVideoDimensions(basePath);
  if (!dims) throw new Error('Could not read the base image dimensions.');
  const sourceRatio = dims.width / dims.height;
  let cropW = dims.width, cropH = dims.height, x = 0, y = 0;
  if (sourceRatio > targetRatio) {
    // Source is relatively wider than the target — crop width down, keep full height.
    cropW = Math.round(dims.height * targetRatio);
    x = Math.round((dims.width - cropW) / 2);
  } else if (sourceRatio < targetRatio) {
    // Source is relatively taller than the target — crop height down, keep full width.
    cropH = Math.round(dims.width / targetRatio);
    y = Math.round((dims.height - cropH) / 2);
  }
  await run('ffmpeg', ['-y', '-i', basePath, '-vf', `crop=${cropW}:${cropH}:${x}:${y}`, '-frames:v', '1', '-update', '1', outPath]);
  return outPath;
}

module.exports = { watermarkLogo, compositeOnColor, textOverlay, reframeToAspect };
