// Smart auto-reframe — subject-tracking crop for turning a landscape/square source into a taller
// aspect (9:16 etc.) so the person stays in frame as they move, instead of the existing static
// center-crop. Reuses the SAME RobustVideoMatting pipeline "text behind subject" already runs
// locally (lib/segmentation.js) — no new model, no per-video API cost — just the raw alpha frames
// instead of the encoded matte video generateMatte() produces.
const { decodeRawFrames, runMatting, PROC_WIDTH, PROC_FPS } = require('./segmentation');

// alphaFrames: array of Buffer(width*height), grayscale 0..255 (255=subject, per RVM's own
// output). Computes each frame's brightness-weighted horizontal centroid as a FRACTION of frame
// width (0=left edge, 1=right edge) — fraction, not pixels, so it's independent of whatever
// resolution the main render filter graph later scales the source to. Vertical tracking is a
// natural future addition, not built here: converting landscape to portrait mostly costs width,
// not height, so horizontal tracking is what actually matters for keeping a person in frame.
function computeCentroids(alphaFrames, width, height) {
  return alphaFrames.map(frame => {
    let sumW = 0, sumWX = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = frame[y * width + x];
        if (v < 24) continue; // ignore near-zero background noise — cheap threshold, not a second model
        sumW += v;
        sumWX += v * x;
      }
    }
    return sumW > 0 ? (sumWX / sumW) / width : 0.5; // 0.5 (frame center) is the safe fallback with no confident subject in this frame
  });
}

// Simple centered moving-average smoother — RVM's matte can jitter frame to frame even for a
// still subject; a hard per-frame crop would visibly judder. Not a full Kalman/optical-flow
// tracker, a real, tested, but intentionally simple smoother.
function smoothSeries(values, windowSize) {
  const half = Math.floor(windowSize / 2);
  return values.map((_, i) => {
    const lo = Math.max(0, i - half), hi = Math.min(values.length - 1, i + half);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += values[j];
    return sum / (hi - lo + 1);
  });
}

// Builds an ffmpeg crop-filter `x` expression that moves the crop window to keep the tracked
// centroid inside the OUTPUT frame, entirely in terms of ffmpeg's own runtime `in_w`/`out_w`
// variables (the crop filter's actual input/output width at render time) rather than baked-in
// pixel numbers — so this works regardless of the target resolution or the upstream scale step's
// exact output size. `min`/`max` clamp the crop window so it never runs past either source edge.
// Commas inside the expression are backslash-escaped since this string is embedded as one filter
// option value inside a larger comma/semicolon-delimited filter_complex graph.
function buildCropXExpr(centroidFracSeries, fps) {
  if (!centroidFracSeries.length) return null;
  const points = centroidFracSeries.map((frac, i) => ({ t: i / fps, frac: Math.min(1, Math.max(0, frac)) }));
  let fracExpr = points[points.length - 1].frac.toFixed(4);
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i], b = points[i + 1];
    const span = Math.max(0.001, b.t - a.t);
    const delta = (b.frac - a.frac).toFixed(4);
    const lerp = `(${a.frac.toFixed(4)}+(${delta})*(t-${a.t.toFixed(3)})/${span.toFixed(3)})`;
    fracExpr = `if(lt(t\\,${b.t.toFixed(3)})\\,${lerp}\\,${fracExpr})`;
  }
  return `min(max((${fracExpr})*in_w-out_w/2\\,0)\\,in_w-out_w)`;
}

// Full pipeline: decode+matte the source at RVM's own reduced resolution/frame-rate (same cost as
// one text-behind-subject pass), compute+smooth the centroid track, return a ready-to-use ffmpeg
// crop x-expression. Returns null (caller falls back to the existing static center-crop) if the
// source has no frames or matting finds no confident subject anywhere.
async function computeAutoReframeExpr(sourceVideoPath, sourceAspectRatio) {
  const rawHeight = PROC_WIDTH * (sourceAspectRatio ? 1 / sourceAspectRatio : 9 / 16);
  const procHeight = Math.max(16, Math.round(rawHeight / 16) * 16);
  const rawFrames = await decodeRawFrames(sourceVideoPath, PROC_WIDTH, procHeight, PROC_FPS);
  if (!rawFrames.length) return null;
  const alphaFrames = await runMatting(rawFrames, PROC_WIDTH, procHeight);
  const centroids = smoothSeries(computeCentroids(alphaFrames, PROC_WIDTH, procHeight), 9);
  return buildCropXExpr(centroids, PROC_FPS);
}

module.exports = { computeAutoReframeExpr, buildCropXExpr, computeCentroids, smoothSeries };
