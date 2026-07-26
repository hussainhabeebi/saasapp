// Real scene/shot-cut detection — ffmpeg's built-in `select='gt(scene,threshold)'` filter scores
// each frame's visual difference from the previous one and (piped through `showinfo`) logs a
// `pts_time` for every frame that crosses the threshold, i.e. every detected cut. Same
// stderr-parsing pattern as lib/timeline.js's detectSilence (also ffmpeg-log-scraping, not a
// separate detection library). Verified against a real 3-scene synthetic test video (three solid
// colors concatenated, cuts at exactly 3s/6s) — the filter reported pts_time 3 and 6 exactly.
const { run } = require('./exec');
const { getDurationSec } = require('./probe');

const PTS_TIME_RE = /pts_time:\s*([\d.]+)/;

// 0.3 is ffmpeg's own commonly-cited default/starting point for this filter — high enough to
// skip ordinary motion/panning within a shot, low enough to catch a real hard cut. Not tunable
// per-project today; a natural future addition, not built.
async function detectCuts(filePath, threshold = 0.3) {
  let stderr = '';
  try {
    const res = await run('ffmpeg', ['-i', filePath, '-filter:v', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-']);
    stderr = res.stderr || '';
  } catch (err) {
    // Same reasoning as detectSilence: ffmpeg can exit non-zero for reasons unrelated to the
    // analysis itself (e.g. no audio stream to also handle) while still having written the
    // showinfo lines we need to stderr.
    stderr = err.stderr || '';
  }
  const cuts = [];
  for (const line of stderr.split('\n')) {
    const m = PTS_TIME_RE.exec(line);
    if (m) cuts.push(parseFloat(m[1]));
  }
  return cuts;
}

// Turns a list of cut timestamps into contiguous [{start,end}] scenes covering the whole video —
// scene 0 always starts at 0, the last scene always ends at the real duration, regardless of
// where ffmpeg's detected cuts fall.
async function detectScenes(filePath, { threshold = 0.3, minSceneSec = 0.75 } = {}) {
  const durationSec = await getDurationSec(filePath);
  const rawCuts = (await detectCuts(filePath, threshold)).filter(t => t > 0 && t < durationSec).sort((a, b) => a - b);

  // Collapses cuts that land within minSceneSec of each other (or of 0/duration) into one —
  // scene detection on busy footage can otherwise fire twice for what's really one hard cut a
  // couple of frames apart, producing slivers too short to usefully caption/edit.
  const cuts = [];
  let last = 0;
  for (const t of rawCuts) {
    if (t - last >= minSceneSec) { cuts.push(t); last = t; }
  }

  const bounds = [0, ...cuts, durationSec];
  const scenes = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] >= minSceneSec || scenes.length === 0) {
      scenes.push({ start: bounds[i], end: bounds[i + 1] });
    } else {
      // A trailing sliver shorter than minSceneSec merges into the previous scene rather than
      // existing as its own — same reasoning as above, applied to the final boundary too.
      scenes[scenes.length - 1].end = bounds[i + 1];
    }
  }
  return scenes;
}

module.exports = { detectScenes };
