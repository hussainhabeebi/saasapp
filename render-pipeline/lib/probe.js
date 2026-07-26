const { run } = require('./exec');

// Duration is reported back to the Worker's render-complete webhook (it uses this to increment
// marketing_minutes_used) — ffprobe on the actual output file is the source of truth, not the
// spec's requested trim range, since silence-cut/segment-splicing can shorten it further.
async function getDurationSec(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const n = parseFloat(stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

// Source video's own pixel dimensions — needed by lib/autoReframe.js to compute the right aspect
// ratio for its reduced-resolution matting pass (must match the source's own aspect, not the
// render's target aspect, since that's what it's tracking a subject within).
async function getVideoDimensions(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=s=x:p=0',
    filePath,
  ]);
  const [w, h] = stdout.trim().split('x').map(Number);
  return (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) ? { width: w, height: h } : null;
}

module.exports = { getDurationSec, getVideoDimensions };
