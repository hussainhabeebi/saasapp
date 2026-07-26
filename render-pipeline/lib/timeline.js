// Silence-cut (spec.silence_cut, "#10 Silence/filler-word auto-cut") — real detection + a real
// edit, not a flag that's silently ignored. All timestamps in this module are in the ORIGINAL
// source video's absolute time (the same timebase the transcript's word.start/word.end already
// use), so keep-segments and the transcript never need to be reconciled against two different
// clocks.
const { run } = require('./exec');

const SILENCE_RE_START = /silence_start:\s*([\d.]+)/;
const SILENCE_RE_END = /silence_end:\s*([\d.]+)/;

// -af atrim (no asetpts reset) keeps silencedetect's reported timestamps in the ORIGINAL file's
// absolute timebase, even though only [trimStart,trimEnd] of the audio is analyzed — exactly
// what computeKeepSegments/remapTime below expect.
async function detectSilence(filePath, trimStart, trimEnd, { noiseDb = -30, minDurationSec = 0.5 } = {}) {
  const filter = `atrim=start=${trimStart}:end=${trimEnd},silencedetect=noise=${noiseDb}dB:d=${minDurationSec}`;
  let stderr = '';
  try {
    const res = await run('ffmpeg', ['-i', filePath, '-af', filter, '-f', 'null', '-']);
    stderr = res.stderr || '';
  } catch (err) {
    // ffmpeg exits non-zero on some inputs even when the analysis itself succeeded (e.g. no
    // video stream to also decode) — the silencedetect log lines are still on stderr, so use
    // them rather than treating this as a hard failure. A genuinely unreadable file will fail
    // again at the real render step below with a clearer error.
    stderr = err.stderr || '';
  }
  const silences = [];
  let pendingStart = null;
  for (const line of stderr.split('\n')) {
    const s = SILENCE_RE_START.exec(line);
    if (s) { pendingStart = parseFloat(s[1]); continue; }
    const e = SILENCE_RE_END.exec(line);
    if (e && pendingStart != null) {
      silences.push({ start: pendingStart, end: parseFloat(e[1]) });
      pendingStart = null;
    }
  }
  return silences;
}

// Complement of the silence intervals within [trimStart,trimEnd] — the segments that actually
// get kept in the output. padSec keeps a small cushion around each cut so a word's onset/offset
// (which silencedetect's noise floor can clip a few hundred ms into) doesn't get chopped;
// minKeepSec drops slivers too short for ffmpeg's concat to handle cleanly.
function computeKeepSegments(trimStart, trimEnd, silences, { padSec = 0.12, minKeepSec = 0.3 } = {}) {
  const cuts = silences
    .map(s => ({ start: Math.max(trimStart, s.start + padSec), end: Math.min(trimEnd, s.end - padSec) }))
    .filter(s => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const segments = [];
  let cursor = trimStart;
  for (const cut of cuts) {
    if (cut.start > cursor) segments.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (trimEnd > cursor) segments.push({ start: cursor, end: trimEnd });

  const kept = segments.filter(s => s.end - s.start >= minKeepSec);
  // Silencedetect misfiring (wrong noise floor, a near-silent whole clip) shouldn't ever produce
  // a zero-length output — fall back to the untouched range rather than rendering nothing.
  return kept.length ? kept : [{ start: trimStart, end: trimEnd }];
}

// Builds a fast originalTime -> finalOutputTime lookup, precomputing each segment's cumulative
// offset once instead of re-summing on every call (this runs once per caption word + once per
// cue, so O(n) per call instead of O(n²) matters once a transcript has a few hundred words).
function makeTimeMapper(keepSegments) {
  let cumulative = 0;
  const withOffsets = keepSegments.map(seg => {
    const entry = { ...seg, offset: cumulative };
    cumulative += seg.end - seg.start;
    return entry;
  });
  const totalDuration = cumulative;

  return function remapTime(originalTime) {
    for (const seg of withOffsets) {
      if (originalTime >= seg.start && originalTime <= seg.end) {
        return seg.offset + (originalTime - seg.start);
      }
    }
    // Falls in a removed gap (or outside every segment entirely) — clamp to whichever kept
    // segment is nearest, so a caption word that starts a beat into a cut still shows up right
    // at the cut point instead of silently vanishing.
    let best = null, bestDist = Infinity;
    for (const seg of withOffsets) {
      const dist = originalTime < seg.start ? seg.start - originalTime : originalTime - seg.end;
      if (dist < bestDist) { bestDist = dist; best = seg; }
    }
    if (!best) return 0;
    return originalTime < best.start ? best.offset : best.offset + (best.end - best.start);
  };
}

module.exports = { detectSilence, computeKeepSegments, makeTimeMapper };
