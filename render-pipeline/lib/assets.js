// Resolves a cue's `tag` (from worker.js's MARKETING_CUE_KEYWORDS, e.g. 'money', 'whoosh',
// 'sparkle') to a local file. Both B-roll and SFX fall back to fetching a real free clip/sound
// when no local file exists — B-roll from Pexels then Pixabay, SFX from Freesound.org — "bring
// your own assets" was a real gap otherwise: a suggested cue with no matching file in
// assets/broll or assets/sfx silently did nothing. Music stays local-only (no free,
// redistributable stock *background music* API used here — Freesound is short sound-effect clips,
// not full tracks). API keys resolve client-first: a client's own key from `spec.client_keys`
// (worker.js's marketingGetClientKeys, Marketing Studio's "🔑 API Keys" settings) takes priority
// over this server's shared env var, so a client who brings their own key gets it used — and, for
// fal.ai specifically, billed to them, not the shared account.
const fs = require('fs');
const path = require('path');
const { downloadToFile } = require('./download');

const BROLL_EXTS = ['.mp4', '.mov', '.webm', '.m4v'];
const SFX_EXTS = ['.mp3', '.wav', '.m4a'];

function apiKeyFor(field, env, clientKeys, envVarName) {
  return clientKeys?.[field] || env?.[envVarName];
}

// Short cue tags searched as-is return weak/unrelated stock-search results ("speed" alone, vs.
// what actually reads as B-roll footage for "someone said something is fast") — a few extra
// keywords per tag noticeably improves relevance without needing a real query-expansion step.
const BROLL_QUERY_MAP = {
  money: 'money currency cash',
  speed: 'fast motion speed',
  office: 'office team meeting work',
  phone: 'smartphone typing messaging',
  location: 'city road travel drone',
  product: 'product unboxing package',
  people: 'happy customers crowd',
};
// Same idea for SFX tags (worker.js's MARKETING_CUE_KEYWORDS sfx entries: sparkle/alert/impact/
// whoosh/click) — Freesound's own tagging vocabulary skews toward these more specific search terms
// rather than the single-word cue tag.
const SFX_QUERY_MAP = {
  sparkle: 'magic sparkle chime',
  alert: 'warning alert beep',
  impact: 'impact hit thud',
  whoosh: 'whoosh transition swoosh',
  click: 'ui click tap',
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

async function fetchFromPexels(tag, apiKey) {
  const query = BROLL_QUERY_MAP[tag] || tag;
  const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&orientation=portrait`, {
    headers: { Authorization: apiKey },
  });
  if (!r.ok) throw new Error(`Pexels search failed: HTTP ${r.status}`);
  const data = await r.json();
  const video = (data.videos || [])[0];
  if (!video) return null;
  const file = pickPexelsFile(video.video_files);
  return file ? file.link : null;
}

// Pixabay has no portrait/orientation filter for video search (only images do) — picks the
// largest available quality tier instead, same "good enough, gets scaled down anyway" reasoning
// as Pexels' 720p floor.
async function fetchFromPixabay(tag, apiKey) {
  const query = BROLL_QUERY_MAP[tag] || tag;
  const r = await fetch(`https://pixabay.com/api/videos/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&per_page=5`);
  if (!r.ok) throw new Error(`Pixabay search failed: HTTP ${r.status}`);
  const data = await r.json();
  const hit = (data.hits || [])[0];
  if (!hit || !hit.videos) return null;
  const tiers = ['large', 'medium', 'small', 'tiny'];
  for (const tier of tiers) { if (hit.videos[tier]?.url) return hit.videos[tier].url; }
  return null;
}

async function fetchStockBroll(assetsRoot, tag, env, clientKeys) {
  const pexelsKey = apiKeyFor('pexels_api_key', env, clientKeys, 'PEXELS_API_KEY');
  const pixabayKey = apiKeyFor('pixabay_api_key', env, clientKeys, 'PIXABAY_API_KEY');
  let sourceUrl = null;
  if (pexelsKey) { try { sourceUrl = await fetchFromPexels(tag, pexelsKey); } catch (err) { console.error(`Pexels fetch(${tag}) failed:`, err.message); } }
  if (!sourceUrl && pixabayKey) { try { sourceUrl = await fetchFromPixabay(tag, pixabayKey); } catch (err) { console.error(`Pixabay fetch(${tag}) failed:`, err.message); } }
  if (!sourceUrl) return null;
  const destPath = path.join(assetsRoot, 'broll', `${tag}.mp4`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await downloadToFile(sourceUrl, destPath);
  return destPath;
}

// Freesound APIv2: search needs only the token (no OAuth), but full-quality Download requires
// OAuth2, which has no place in a server-to-server integration like this one. Preview files
// (compressed but still solid quality — several bitrate tiers) need NO OAuth2 at all, and for a
// 1-3 second SFX sting, preview quality is indistinguishable from the original in the final
// render. Verified against the real API docs before building this — see SETUP.md.
async function fetchFromFreesound(tag, apiKey) {
  const query = SFX_QUERY_MAP[tag] || tag;
  const r = await fetch(`https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(query)}&filter=duration:[0.2 TO 6]&sort=score&page_size=5&fields=id,previews&token=${encodeURIComponent(apiKey)}`);
  if (!r.ok) throw new Error(`Freesound search failed: HTTP ${r.status}`);
  const data = await r.json();
  const hit = (data.results || [])[0];
  if (!hit || !hit.previews) return null;
  return hit.previews['preview-hq-mp3'] || hit.previews['preview-lq-mp3'] || null;
}

async function fetchStockSfx(assetsRoot, tag, env, clientKeys) {
  const apiKey = apiKeyFor('freesound_api_key', env, clientKeys, 'FREESOUND_API_KEY');
  if (!apiKey) return null;
  let sourceUrl;
  try { sourceUrl = await fetchFromFreesound(tag, apiKey); }
  catch (err) { console.error(`Freesound fetch(${tag}) failed:`, err.message); return null; }
  if (!sourceUrl) return null;
  const destPath = path.join(assetsRoot, 'sfx', `${tag}.mp3`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await downloadToFile(sourceUrl, destPath);
  return destPath;
}

// env/clientKeys optional so callers that only care about local assets still work. Cached to
// assets/broll|sfx/<tag>.<ext> on first fetch, so the external API call only ever happens once
// per tag, ever — every later render with the same cue tag hits the local-file branch instead.
async function resolveBroll(assetsRoot, tag, env, clientKeys) {
  const local = findAsset(path.join(assetsRoot, 'broll'), tag, BROLL_EXTS);
  if (local) return local;
  if (!tag) return null;
  try { return await fetchStockBroll(assetsRoot, tag, env, clientKeys); }
  catch (err) { console.error(`fetchStockBroll(${tag}) failed:`, err.message); return null; }
}
async function resolveSfx(assetsRoot, tag, env, clientKeys) {
  const local = findAsset(path.join(assetsRoot, 'sfx'), tag, SFX_EXTS);
  if (local) return local;
  if (!tag) return null;
  try { return await fetchStockSfx(assetsRoot, tag, env, clientKeys); }
  catch (err) { console.error(`fetchStockSfx(${tag}) failed:`, err.message); return null; }
}
function resolveMusic(assetsRoot, key) {
  return findAsset(path.join(assetsRoot, 'music'), key, SFX_EXTS.concat('.ogg'));
}

module.exports = { resolveBroll, resolveSfx, resolveMusic };
