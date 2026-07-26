const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// The Worker's /marketing/media/:key route (source video, and B-roll assets fetched the same
// way if ever hosted remotely) — plain public GET, no auth header needed (see worker.js's own
// comment on handleMarketingMediaServe's trust model).
async function downloadToFile(url, destPath) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`Download failed (${r.status}) for ${url}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(destPath));
  return destPath;
}

module.exports = { downloadToFile };
