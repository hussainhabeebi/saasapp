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

module.exports = { getDurationSec };
