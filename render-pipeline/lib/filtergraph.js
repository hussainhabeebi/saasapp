// Assembles one ffmpeg invocation (input list + filter_complex + output map) from a render job's
// resolved pieces. Every technique here (segment trim+concat for silence-cut, zoompan for
// auto-zoom, subtitles for caption burn-in, overlay+enable for B-roll PiP, eq+enable for the VFX
// flash, adelay+amix for one-shot SFX, volume+amix for background music) was hand-verified
// against a real ffmpeg run before being wired in here — see the dev notes in README.md.
//
// Kept as a pure "spec in, argv out" function (no I/O) so it's unit-testable without invoking
// ffmpeg at all.

// Export quality control — trades encode time for output quality/bitrate. 'standard' is the
// previous hardcoded default, unchanged for anyone not explicitly picking a quality.
const QUALITY_PRESETS = {
  draft: { crf: 28, preset: 'ultrafast' },     // fastest — quick previews/iterating on cuts
  standard: { crf: 21, preset: 'veryfast' },   // default — good balance for short-form delivery
  high: { crf: 17, preset: 'medium' },         // noticeably slower encode, visibly cleaner output
};

// Both re-validated here (not just at the Worker, which already validates before this spec is
// HMAC-signed and sent over) since these strings get interpolated straight into an ffmpeg filter
// expression — cheap defense in depth against a malformed/compromised spec producing filtergraph
// (or, worse, argv) injection rather than just a render error.
const HEX_COLOR_RE = /^#?[0-9a-fA-F]{6}$/;
function sanitizeHexColor(c, fallback) {
  return typeof c === 'string' && HEX_COLOR_RE.test(c) ? '0x' + c.replace('#', '') : fallback;
}

function buildFfmpegArgs({
  inputPath,
  keepSegments,          // [{start, end}] in the SOURCE video's absolute time — see lib/timeline.js
  resolutionW, resolutionH,
  fps = 30,
  assPath,                // pre-written .ass subtitle file, or null for no captions
  watermark = false,
  autoZoom = false,
  music,                  // {path, volume} or null
  sfx = [],               // [{path, atSec}] — atSec already remapped to the OUTPUT timeline
  broll = [],             // [{path, startSec, endSec, scale}] — remapped to the OUTPUT timeline
  vfx = [],               // [{type, startSec, endSec}] — remapped to the OUTPUT timeline
  quality = 'standard',   // 'draft' | 'standard' | 'high' — see QUALITY_PRESETS
  denoise = false,        // ffmpeg's built-in FFT denoiser (afftdn) — no external model file needed
  chromaKey = null,       // {color, similarity, blend, background_color} or null — green-screen keying
  speedFactor = 1,        // 0.5-2.0 — a single GLOBAL speed change (slow-mo/time-lapse), not CapCut's
                           // full per-segment speed ramping — see SETUP.md's scope note on this
  cropXExpr = null,       // pre-computed ffmpeg crop `x` expression from lib/autoReframe.js, or
                           // null for the plain static center-crop — computed by render.js (needs
                           // I/O: decode+matte) BEFORE calling this pure function, same division of
                           // labor as words/broll/sfx resolution already happening upstream of here
  fontsDir = null,        // directory of custom .ttf/.otf files (render-pipeline/fonts/) — passed
                           // to ffmpeg's subtitles filter's own `fontsdir` option so a caption
                           // style's font name can resolve to a dropped-in file, not just whatever
                           // happens to be installed system-wide (see fonts/README.md)
  outputPath,
}) {
  const q = QUALITY_PRESETS[quality] || QUALITY_PRESETS.standard;
  const inputs = ['-i', inputPath];
  const extraInputIndexByPath = new Map();
  let nextInputIndex = 1;
  function addInput(path, extraArgs = []) {
    if (extraInputIndexByPath.has(path)) return extraInputIndexByPath.get(path);
    inputs.push(...extraArgs, '-i', path);
    const idx = nextInputIndex++;
    extraInputIndexByPath.set(path, idx);
    return idx;
  }

  const filters = [];

  // 1) Segment trim + concat — a single segment collapses to a plain trim (concat n=1 is a
  // harmless no-op in ffmpeg, so there's no special-cased branch for "no silence-cut").
  const segs = keepSegments && keepSegments.length ? keepSegments : [{ start: 0, end: 1e9 }];
  segs.forEach((seg, i) => {
    filters.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[cv${i}]`);
    filters.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[ca${i}]`);
  });
  const concatIn = segs.map((_, i) => `[cv${i}][ca${i}]`).join('');
  filters.push(`${concatIn}concat=n=${segs.length}:v=1:a=1[vcat][acat]`);

  // 2) Crop/scale to the target aspect — upscale-to-cover, then either a plain center-crop, or,
  // when cropXExpr is given (smart auto-reframe, lib/autoReframe.js), a subject-tracking crop that
  // moves the window instead of always taking the middle slice. `x` accepts a runtime expression
  // string exactly the same way the existing zoompan/eq/overlay `enable` expressions below do —
  // this isn't a new mechanism, just the first user of it on the crop filter specifically.
  const cropX = cropXExpr || `(in_w-out_w)/2`;
  filters.push(`[vcat]scale=${resolutionW}:${resolutionH}:force_original_aspect_ratio=increase,crop=${resolutionW}:${resolutionH}:x='${cropX}':y=0[vcrop]`);
  let vChain = 'vcrop';

  // 2b) Green screen / chroma key — keys out the given color and composites onto a solid
  // background instead (a background IMAGE, not just a color, is a natural future addition, not
  // built here — v1 scope, same "real but bounded" pattern as B-roll PiP above). `color` here is
  // an ffmpeg *source* filter (generates its own frames), not a second file input — no extra -i
  // needed, same trick zoompan/subtitles use for not needing external assets.
  if (chromaKey && chromaKey.enabled) {
    const keyColor = sanitizeHexColor(chromaKey.color, '0x00FF00');
    const bgColor = sanitizeHexColor(chromaKey.background_color, '0x000000');
    const similarity = Math.min(0.6, Math.max(0.05, Number(chromaKey.similarity) || 0.3));
    const blend = Math.min(0.5, Math.max(0, Number(chromaKey.blend) || 0.1));
    filters.push(`color=c=${bgColor}:s=${resolutionW}x${resolutionH}:d=1200[ckbg]`);
    filters.push(`[${vChain}]colorkey=${keyColor}:${similarity}:${blend},format=yuva420p[vkeyed]`);
    filters.push(`[ckbg][vkeyed]overlay=shortest=1,format=yuv420p[vck]`);
    vChain = 'vck';
  }

  // 3) Auto-zoom — a slow, continuous punch-in for the whole clip (d=1 so it maps input frames
  // 1:1 instead of duplicating them, which is what makes zoompan usable on real video rather than
  // just still images).
  if (autoZoom) {
    filters.push(`[${vChain}]zoompan=z='min(zoom+0.0006,1.18)':d=1:s=${resolutionW}x${resolutionH}:fps=${fps}[vzoom]`);
    vChain = 'vzoom';
  }

  // 4) B-roll — a corner picture-in-picture insert while the cue is active, not a full-frame
  // cutaway (see SETUP.md for why: a cutaway needs the same segment-splice machinery silence-cut
  // uses, which would also have to re-run the caption/cue time-remap through it; PiP overlay
  // reaches the same "there's B-roll visible for this cue" outcome without touching the main
  // timeline at all).
  broll.forEach((b, i) => {
    const idx = addInput(b.path);
    const pipSize = Math.round(resolutionW * (b.scale || 0.42));
    filters.push(`[${idx}:v]scale=${pipSize}:-1[broll${i}]`);
    filters.push(`[${vChain}][broll${i}]overlay=x=main_w-overlay_w-24:y=main_h-overlay_h-${Math.round(resolutionH * 0.16)}:enable='between(t,${b.startSec},${b.endSec})'[vbroll${i}]`);
    vChain = `vbroll${i}`;
  });

  // 5) VFX — filter-only effects (no asset needed), gated to the cue's time window via `enable`.
  vfx.forEach((v, i) => {
    const label = `vvfx${i}`;
    if (v.type === 'flash') {
      filters.push(`[${vChain}]eq=brightness='if(between(t,${v.startSec},${v.endSec}),0.35,0)':enable='between(t,${v.startSec},${v.endSec})'[${label}]`);
    } else if (v.type === 'badge' || v.type === 'split') {
      // Approximated the same way for both — a quick punch-in scale pulse via zoompan isn't
      // per-window-able cheaply here, so this uses a saturation/contrast pop as the "something
      // changed here" visual cue instead of a literal split-screen or badge overlay (which would
      // need actual badge artwork this repo doesn't have).
      filters.push(`[${vChain}]eq=saturation='if(between(t,${v.startSec},${v.endSec}),1.6,1.0)':contrast='if(between(t,${v.startSec},${v.endSec}),1.15,1.0)':enable='between(t,${v.startSec},${v.endSec})'[${label}]`);
    } else {
      filters.push(`[${vChain}]null[${label}]`);
    }
    vChain = label;
  });

  // 6) Captions burn-in. `fontsdir` is libass's own documented mechanism for using font files that
  // aren't installed as a system font — no fontconfig/fc-cache registration needed, and it's read
  // straight off disk at render time, so a font file dropped in between renders is picked up
  // immediately (see fonts/README.md for the "drop a .ttf/.otf in, reference its family name in a
  // style" workflow this enables, e.g. for a specific Malayalam typeface instead of whatever
  // system fallback font fonts-noto-core happens to provide).
  if (assPath) {
    const fontsdirClause = fontsDir ? `:fontsdir=${escapeFilterPath(fontsDir)}` : '';
    filters.push(`[${vChain}]subtitles=${escapeFilterPath(assPath)}${fontsdirClause}[vsub]`);
    vChain = 'vsub';
  }

  // 7) Watermark (free-tier export — spec.watermark, mirrors the paid-tier gate in worker.js).
  if (watermark) {
    filters.push(`[${vChain}]drawtext=text='Made with Leadvyne':fontcolor=white@0.75:fontsize=${Math.round(resolutionH * 0.022)}:x=w-tw-24:y=h-th-24:shadowcolor=black@0.6:shadowx=2:shadowy=2[vout]`);
    vChain = 'vout';
  } else {
    filters.push(`[${vChain}]null[vout]`);
    vChain = 'vout';
  }

  // 8) Audio — speech (already through the same segment concat as the video) plus optional
  // background music (volume-reduced, trimmed to the output length — a constant-level duck, not
  // true sidechain compression; see README's "known limitations") plus optional one-shot SFX.
  // Noise reduction — ffmpeg's own FFT denoiser (afftdn), applied to the speech track only
  // (before music/SFX are mixed in, which are already clean synthetic/stock audio that doesn't
  // need it). No external model file to ship, unlike RNNoise's arnndn — genuinely zero extra cost.
  let speechLabel = 'acat';
  if (denoise) {
    filters.push(`[acat]afftdn=nf=-25[adenoise]`);
    speechLabel = 'adenoise';
  }

  const audioMixInputs = [`[${speechLabel}]`];
  if (music) {
    const idx = addInput(music.path, ['-stream_loop', '-1']);
    filters.push(`[${idx}:a]volume=${music.volume ?? 0.15}[bgm]`);
    audioMixInputs.push('[bgm]');
  }
  sfx.forEach((s, i) => {
    const idx = addInput(s.path);
    const delayMs = Math.max(0, Math.round(s.atSec * 1000));
    filters.push(`[${idx}:a]adelay=${delayMs}|${delayMs}[sfx${i}]`);
    audioMixInputs.push(`[sfx${i}]`);
  });
  if (audioMixInputs.length > 1) {
    filters.push(`${audioMixInputs.join('')}amix=inputs=${audioMixInputs.length}:duration=first:dropout_transition=0[aout]`);
  } else {
    filters.push(`[${speechLabel}]anull[aout]`);
  }
  let aChain = 'aout';

  // 9) Global speed ramp — applied LAST, after captions are already burned in and audio is
  // already mixed, so both simply play back faster/slower together; captions don't need their own
  // timing recomputed since they're baked into pixels at their original real-time position, which
  // is what this step then uniformly stretches/compresses. A single clip-wide factor, not
  // CapCut's full per-segment speed *ramping* (varying speed within one clip) — see SETUP.md.
  // atempo's own valid range is 0.5-2.0 per instance, which is also this feature's clamp range, so
  // one filter instance always covers it (no need to chain several for a wider range).
  if (speedFactor && speedFactor !== 1) {
    const clamped = Math.min(2, Math.max(0.5, Number(speedFactor) || 1));
    filters.push(`[${vChain}]setpts=PTS/${clamped}[vspeed]`);
    vChain = 'vspeed';
    filters.push(`[${aChain}]atempo=${clamped}[aspeed]`);
    aChain = 'aspeed';
  }

  const args = [
    '-y', ...inputs,
    '-filter_complex', filters.join('; '),
    '-map', `[${vChain}]`, '-map', `[${aChain}]`,
    '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf),
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    outputPath,
  ];
  return args;
}

// The `subtitles` filter's path argument has its own mini-escaping rules on top of the shell
// (colons and backslashes are filtergraph syntax) — since this always renders into a controlled
// tmp directory with a generated filename (never user input), this only needs to handle the
// characters that path can realistically contain, not a fully general escaper.
function escapeFilterPath(p) {
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;
}

module.exports = { buildFfmpegArgs, QUALITY_PRESETS };
