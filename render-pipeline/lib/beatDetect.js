// Beat/onset detection for "snap this cut point to the music" — a real, from-scratch spectral-flux
// -style onset detector over raw PCM, NOT a full tempo/beat tracker like librosa's beat_track
// (which fits a global BPM grid and phase). This finds ENERGY ONSETS (moments the audio gets
// suddenly louder — drum hits, transients), which is what "cut on the beat" actually needs for
// short-form video; it does not infer or enforce a steady tempo. No new npm dependency — decodes
// via the ffmpeg binary already required everywhere else in this pipeline, then does the energy/
// peak-picking math in plain JS.
const { spawn } = require('child_process');

const SAMPLE_RATE = 22050;   // downsampled — plenty for onset energy, far cheaper to process than 44.1k
const FRAME_SIZE = 1024;     // ~46ms per frame at 22050Hz
const HOP_SIZE = 512;        // 50% overlap

function decodePcm(sourcePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', sourcePath,
      '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-',
    ]);
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 && !chunks.length) return reject(new Error('ffmpeg PCM decode failed: ' + stderr.slice(-500)));
      resolve(Buffer.concat(chunks));
    });
  });
}

function pcmToFrameEnergies(pcmBuffer) {
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.length / 2));
  const energies = [];
  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP_SIZE) {
    let sumSq = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const s = samples[start + i] / 32768;
      sumSq += s * s;
    }
    energies.push(Math.sqrt(sumSq / FRAME_SIZE)); // RMS
  }
  return energies;
}

// Spectral-flux-style novelty without an actual FFT: half-wave-rectified frame-to-frame RMS
// energy increase. Cheaper than a real spectral flux (which would need per-bin FFT deltas) and
// specifically tuned for what this feature needs (percussive/onset energy jumps), not a general
// substitute for one.
function noveltyFromEnergies(energies) {
  const novelty = [0];
  for (let i = 1; i < energies.length; i++) novelty.push(Math.max(0, energies[i] - energies[i - 1]));
  return novelty;
}

// Adaptive-threshold local-maxima peak picking: a frame counts as a beat if it's a local max over
// its own neighborhood AND exceeds (local mean + k*local std) — the adaptive-threshold half is
// what keeps this working across a track's own loud/quiet sections instead of one fixed cutoff.
// minGapSec enforces a floor on beat spacing (default caps effective tempo detection at 240 BPM)
// so a burst of consecutive frames around one real hit doesn't register as several beats.
function pickPeaks(novelty, fps, { windowSec = 1.0, k = 1.5, minGapSec = 0.25 } = {}) {
  const windowFrames = Math.max(1, Math.round((windowSec * fps) / 2));
  const minGapFrames = Math.max(1, Math.round(minGapSec * fps));
  const peaks = [];
  let lastPeakIdx = -Infinity;
  for (let i = 0; i < novelty.length; i++) {
    const lo = Math.max(0, i - windowFrames), hi = Math.min(novelty.length - 1, i + windowFrames);
    let sum = 0, sumSq = 0, n = 0;
    for (let j = lo; j <= hi; j++) { sum += novelty[j]; sumSq += novelty[j] * novelty[j]; n++; }
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    const threshold = mean + k * std;
    if (novelty[i] <= threshold || novelty[i] <= 0) continue;
    const isLocalMax = novelty[i] >= (novelty[i - 1] ?? -Infinity) && novelty[i] >= (novelty[i + 1] ?? -Infinity);
    if (!isLocalMax) continue;
    if (i - lastPeakIdx < minGapFrames) continue;
    peaks.push(i);
    lastPeakIdx = i;
  }
  return peaks;
}

// Detects beat/onset timestamps (seconds) across the given time range of the source's audio.
async function detectBeats(sourcePath, startSec = 0, endSec = null) {
  const pcm = await decodePcm(sourcePath);
  const energies = pcmToFrameEnergies(pcm);
  const fps = SAMPLE_RATE / HOP_SIZE; // "frames per second" of the energy/novelty series, not video fps
  const novelty = noveltyFromEnergies(energies);
  const peaks = pickPeaks(novelty, fps);
  const times = peaks.map(i => i / fps).filter(t => t >= startSec && (endSec == null || t <= endSec));
  return times;
}

// Snaps each of `points` (seconds) to its nearest beat if one exists within maxSnapSec, otherwise
// leaves it unchanged — used to align B-roll/scene cut points to the music without forcing every
// cut onto a beat regardless of how far off it started (that would defeat cuts that are correctly
// timed to the SPEECH instead, e.g. a keyword-triggered B-roll cue).
function snapToBeats(points, beats, maxSnapSec = 0.35) {
  if (!beats.length) return points.slice();
  return points.map(p => {
    let best = null, bestDist = Infinity;
    for (const b of beats) {
      const d = Math.abs(b - p);
      if (d < bestDist) { bestDist = d; best = b; }
    }
    return (best !== null && bestDist <= maxSnapSec) ? best : p;
  });
}

module.exports = { detectBeats, snapToBeats, pcmToFrameEnergies, noveltyFromEnergies, pickPeaks };
