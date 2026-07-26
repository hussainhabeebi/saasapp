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
const { findFillerWordRanges, isFillerWord } = require('./fillerWords');
const { writeAssFile } = require('./subtitles');
const { buildFfmpegArgs } = require('./filtergraph');
const { run } = require('./exec');
const { getDurationSec, getVideoDimensions } = require('./probe');
const { resolveBroll, resolveSfx, resolveMusic } = require('./assets');
const { uploadOutput } = require('./storage');
const { renderTextBehindSubject } = require('./textBehindSubject');
const { computeAutoReframeExpr } = require('./autoReframe');
const { detectBeats, snapToBeats } = require('./beatDetect');

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
    // text_behind_subject renders the actual video as a single plain trim (see below) — if
    // silence-cut/filler-word-cut also ran here, caption timestamps would get remapped as though
    // the video had gaps removed while the video itself doesn't, desyncing every caption. v1
    // doesn't support combining the two (see textBehindSubject.js's header comment), so both are
    // a no-op whenever text_behind_subject is set, not a silently-broken combination.
    if ((spec.silence_cut || spec.filler_word_cut) && !spec.text_behind_subject) {
      // Filler-word ranges reuse the exact same keep-segment machinery silence-cut already uses
      // (lib/timeline.js's computeKeepSegments doesn't care WHY a range should be cut) — real
      // reuse, not a parallel implementation. See lib/fillerWords.js.
      let cutRanges = spec.silence_cut ? await detectSilence(sourcePath, trimStart, trimEnd) : [];
      if (spec.filler_word_cut) cutRanges = cutRanges.concat(findFillerWordRanges(spec.captions?.words));
      keepSegments = computeKeepSegments(trimStart, trimEnd, cutRanges);
    } else {
      keepSegments = [{ start: trimStart, end: trimEnd }];
    }
    const remap = makeTimeMapper(keepSegments);

    // Filler words are dropped from the caption track entirely when filler_word_cut is on — the
    // audio/video underneath them is being cut, so captioning them would show text with nothing
    // corresponding to it in the final video.
    const captionWords = spec.filler_word_cut
      ? (spec.captions?.words || []).filter(w => !isFillerWord(w.word))
      : (spec.captions?.words || []);
    const words = captionWords.map(w => ({
      word: w.word,
      start: remap(Number(w.start) || 0),
      end: remap(Number(w.end) || 0),
    }));

    const { w: resolutionW, h: resolutionH } = parseResolution(spec.resolution);

    let music = null;
    if (spec.background_music) {
      const musicPath = resolveMusic(assetsRoot, spec.background_music);
      if (musicPath) music = { path: musicPath, volume: 0.15 };
    }

    // Beat-synced cuts (spec.beat_sync) — "cut on the beat" for B-roll/SFX cues, snapping each
    // cue's start time to the nearest detected beat in the background music (lib/beatDetect.js:
    // real energy-onset detection, not a tempo-grid beat tracker — see that file's header for the
    // distinction). The music track plays on a loop in the final render (`-stream_loop -1` in
    // filtergraph.js), so its own beat pattern is tiled across the full output duration here to
    // match — snapping against only the music's first loop would silently stop working past its
    // own length. Best-effort: if detection fails (e.g. corrupt music file), cues simply keep
    // their original (script-derived) timing instead of failing the render.
    let musicBeats = [];
    if (spec.beat_sync && music) {
      try {
        const [rawBeats, musicDurSec] = await Promise.all([detectBeats(music.path), getDurationSec(music.path)]);
        const totalOutputSec = keepSegments.reduce((sum, s) => sum + (s.end - s.start), 0);
        if (rawBeats.length && musicDurSec > 0) {
          for (let loop = 0; loop * musicDurSec <= totalOutputSec; loop++) {
            for (const b of rawBeats) {
              const t = b + loop * musicDurSec;
              if (t <= totalOutputSec) musicBeats.push(t);
            }
          }
        }
      } catch (err) {
        console.error('beat detection failed, cues keep their original timing:', err.message || err);
      }
    }

    const acceptedCues = (spec.cues || []).filter(c => c.accepted !== false);
    const broll = [];
    const sfx = [];
    const vfx = [];
    for (const cue of acceptedCues) {
      let start = remap(Number(cue.start) || 0);
      let end = Math.max(start + 0.3, remap(Number(cue.end) || 0));
      if (musicBeats.length && (cue.type === 'broll' || cue.type === 'sfx')) {
        const duration = end - start;
        const [snappedStart] = snapToBeats([start], musicBeats, 0.35);
        if (snappedStart !== start) { start = snappedStart; end = start + duration; }
      }
      if (cue.type === 'broll') {
        const assetPath = await resolveBroll(assetsRoot, cue.tag, env, spec.client_keys);
        if (assetPath) broll.push({ path: assetPath, startSec: start, endSec: end });
      } else if (cue.type === 'sfx') {
        const assetPath = await resolveSfx(assetsRoot, cue.tag, env, spec.client_keys);
        if (assetPath) sfx.push({ path: assetPath, atSec: start });
      } else if (cue.type === 'vfx') {
        vfx.push({ type: cue.tag, startSec: start, endSec: end }); // vfx needs no asset — pure filter effect
      }
    }

    let assPath = null;
    if (words.length) {
      assPath = path.join(workDir, 'captions.ass');
      writeAssFile(assPath, words, spec.style || {}, { resolutionW, resolutionH });
    }

    // "Text behind subject" (spec.text_behind_subject) — a structurally different compositing
    // pipeline (background+text, THEN the person cut out on top), not a variant of the normal
    // burn-on-top filter graph below. v1 scope: doesn't combine with silence-cut/auto-zoom/
    // B-roll/SFX/VFX cues in the same render — see README.md's known limitations. Runs local
    // ONNX person-matting (lib/segmentation.js), no per-video API cost.
    if (spec.text_behind_subject) {
      const trimmedPath = path.join(workDir, 'trimmed.mp4');
      await run('ffmpeg', ['-y', '-i', sourcePath, '-ss', String(trimStart), '-to', String(trimEnd), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', trimmedPath]);
      const mattePath = path.join(workDir, 'matte.mp4');
      const outputPath = path.join(workDir, 'output.mp4');
      await renderTextBehindSubject({
        sourcePath: trimmedPath, resolutionW, resolutionH, fps: 30,
        assPath, bgColor: spec.style?.bg_color, watermark: !!spec.watermark, quality: spec.quality, outputPath,
      }, mattePath);
      const durationSec = await getDurationSec(outputPath);
      const key = `marketing/${job.client_id}/${job.project_id}/render-${crypto.randomBytes(6).toString('hex')}.mp4`;
      const result = await uploadOutput(env, outputPath, key);
      return { ...result, duration_sec: durationSec };
    }

    // Smart auto-reframe (spec.auto_reframe) — reuses the same local RVM matting model
    // text-behind-subject uses (lib/segmentation.js), just to track a subject's horizontal
    // position instead of cutting them out. Best-effort: matting can fail (missing model file,
    // decode error, no confident subject anywhere) — that degrades to the existing plain
    // center-crop rather than failing the whole render, same "best-effort, never blocks the core
    // render" pattern as scene thumbnails.
    let cropXExpr = null;
    if (spec.auto_reframe) {
      try {
        const dims = await getVideoDimensions(sourcePath);
        if (dims) cropXExpr = await computeAutoReframeExpr(sourcePath, dims.width / dims.height);
      } catch (err) {
        console.error('auto-reframe failed, falling back to center-crop:', err.message || err);
      }
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
      quality: spec.quality,
      denoise: !!spec.denoise,
      chromaKey: spec.chroma_key || null,
      speedFactor: Number(spec.speed_factor) || 1,
      cropXExpr,
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
