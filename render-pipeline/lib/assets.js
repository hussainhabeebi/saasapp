// Resolves a cue's `tag` (from worker.js's MARKETING_CUE_KEYWORDS, e.g. 'money', 'whoosh',
// 'sparkle') to a local file, if the operator has actually dropped one in. No footage/audio ships
// in this repo — there's no license to redistribute stock B-roll or SFX — so this is deliberately
// a "bring your own assets" convention: drop a file named after the tag in assets/broll or
// assets/sfx and it gets picked up automatically; if it's missing, that cue is silently skipped
// (logged, not fatal) rather than failing the whole render.
const fs = require('fs');
const path = require('path');

const BROLL_EXTS = ['.mp4', '.mov', '.webm', '.m4v'];
const SFX_EXTS = ['.mp3', '.wav', '.m4a'];

function findAsset(dir, tag, exts) {
  if (!tag) return null;
  for (const ext of exts) {
    const candidate = path.join(dir, `${tag}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveBroll(assetsRoot, tag) {
  return findAsset(path.join(assetsRoot, 'broll'), tag, BROLL_EXTS);
}
function resolveSfx(assetsRoot, tag) {
  return findAsset(path.join(assetsRoot, 'sfx'), tag, SFX_EXTS);
}
function resolveMusic(assetsRoot, key) {
  return findAsset(path.join(assetsRoot, 'music'), key, SFX_EXTS.concat('.ogg'));
}

module.exports = { resolveBroll, resolveSfx, resolveMusic };
