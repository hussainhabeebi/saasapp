// Resolves a cue's `tag` (from worker.js's MARKETING_CUE_KEYWORDS, e.g. 'money', 'whoosh',
// 'sparkle') to a local file. B-roll additionally falls back to fetching a real royalty-free clip
// from Pexels' free stock video API when no local file exists and PEXELS_API_KEY is configured —
// "bring your own assets" was a real gap otherwise: a suggested B-roll cue with no matching file
// in assets/broll silently did nothing. SFX/music stay local-only (no free, redistributable stock
// audio API used here) — drop a file named after the tag in assets/sfx or assets/music and it
// gets picked up automatically; if it's missing, that cue is silently skipped (logged, not fatal)
// rather than failing the whole render.
const fs = require('fs');
const path = require('path');
const { downloadToFile } = require('./download');

const BROLL_EXTS = ['.mp4', '.mov', '.webm', '.m4v'];
const SFX_EXTS = ['.mp3', '.wav', '.m4a'];

// Short cue tags searched as-is return weak/unrelated Pexels results ("speed" alone, vs. what
// actually reads as B-roll footage for "someone said something is fast") — a few extra keywords
// per tag noticeably improves relevance without needing a real query-expansion step.
const PEXELS_QUERY_MAP = {
  money: 'money currency cash',
  speed: 'fast motion speed',
  office: 'office team meeting work',
  phone: 'smartphone typing messaging',
  location: 'city road travel drone',
  product: 'product unboxing package',
  people: 'happy customers crowd',
};

function findAsset(dir, tag, exts) {
  if (!tag) return null;
  for (const ext of exts) {
    const candidate = path.join(dir, `${tag}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Picks the smallest video_file at or above 720p tall (vertical-friendly) — Marketing Studio's
// exports are mostly 9:16, and a needlessly huge 4K download only costs more time/bandwidth for a
// B-roll clip that gets scaled down and shown for a couple of seconds as a PiP overlay anyway.
function pickPexelsFile(files) {
  const mp4s = (files || []).filter(f => f.file_type === 'video/mp4' && f.link);
  if (!mp4s.length) return null;
  const tall = mp4s.filter(f => f.height >= f.width); // prefer portrait/square over landscape
  const pool = tall.length ? tall : mp4s;
  return pool.slice().sort((a, b) => (a.height || 0) - (b.height || 0))
    .find(f => f.height >= 720) || pool.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
}

async function fetchStockBroll(assetsRoot, tag, apiKey) {
  const query = PEXELS_QUERY_MAP[tag] || tag;
  const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&orientation=portrait`, {
    headers: { Authorization: apiKey },
  });
  if (!r.ok) throw new Error(`Pexels search failed: HTTP ${r.status}`);
  const data = await r.json();
  const video = (data.videos || [])[0];
  if (!video) return null;
  const file = pickPexelsFile(video.video_files);
  if (!file) return null;
  const destPath = path.join(assetsRoot, 'broll', `${tag}.mp4`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await downloadToFile(file.link, destPath);
  return destPath;
}

// Async now (was sync) — the Pexels fallback needs network I/O. env is optional so callers that
// only care about local assets (none currently, but keeps the signature honest) still work.
async function resolveBroll(assetsRoot, tag, env) {
  const local = findAsset(path.join(assetsRoot, 'broll'), tag, BROLL_EXTS);
  if (local) return local;
  if (!tag || !env?.PEXELS_API_KEY) return null;
  try {
    // Cached to assets/broll/<tag>.mp4 on first fetch, so this Pexels call only ever happens
    // once per tag, ever — every later render with the same cue tag hits the local-file branch
    // above instead.
    return await fetchStockBroll(assetsRoot, tag, env.PEXELS_API_KEY);
  } catch (err) {
    console.error(`fetchStockBroll(${tag}) failed:`, err.message);
    return null; // same "skip the cue, don't fail the render" contract as a missing local file
  }
}
function resolveSfx(assetsRoot, tag) {
  return findAsset(path.join(assetsRoot, 'sfx'), tag, SFX_EXTS);
}
function resolveMusic(assetsRoot, key) {
  return findAsset(path.join(assetsRoot, 'music'), key, SFX_EXTS.concat('.ogg'));
}

module.exports = { resolveBroll, resolveSfx, resolveMusic };
