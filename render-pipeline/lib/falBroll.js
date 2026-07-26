// AI-generated B-roll via fal.ai's queue API — for when a cue has no matching stock footage
// (Pexels/Pixabay) and the client wants something purpose-generated instead. Unlike Pexels/
// Pixabay/Freesound, fal.ai is PAID (per second of generated video) — requires a client-supplied
// key (spec.client_keys.fal_api_key), never a shared server default, so a client's own generation
// spend bills to their own key.
//
// Runs as its own job in the SAME queue/webhook machinery every other render job already uses
// (spec.mode:'ai-broll', dispatched in server.js) rather than new infrastructure — a real
// generation can take tens of seconds to a few minutes, which is exactly the kind of job this
// pipeline's async queue+callback pattern already exists for.
//
// What's verified vs. not: the queue submit/status endpoints, the `Authorization: Key <key>`
// header, and the webhook-vs-poll options are confirmed against fal.ai's own documentation. The
// exact result payload shape (`result.video.url`) is corroborated by third-party
// docs/code-example sources quoting the fal-ai/wan model's API, not fal's own docs directly (no
// live fal.ai key was available to test against in the dev sandbox this was built in) — the
// polling code defensively checks a couple of plausible result-field locations; if a real
// generation completes but no video is found, the error message says exactly what came back so
// the field name can be corrected in one place.
const fs = require('fs');
const path = require('path');
const { downloadToFile } = require('./download');

// v2.7 text-to-video: 2-15s duration, supports 9:16/1:1/16:9 — matches this app's target aspects
// directly. A cheaper/faster model than Kling; a reasonable default, not the only option fal.ai
// offers (a natural future addition: let a client pick their own model).
const FAL_MODEL = 'fal-ai/wan/v2.7/text-to-video';
const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 5 * 60 * 1000; // bounded so a stuck generation can't hang this pipeline's single-worker job queue forever

async function submitFalJob(prompt, apiKey, aspectRatio) {
  const r = await fetch(`https://queue.fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, duration: 5, aspect_ratio: aspectRatio }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.detail || data?.error?.message || `fal.ai submit failed: HTTP ${r.status}`);
  if (!data.request_id) throw new Error('fal.ai did not return a request_id.');
  return data.request_id;
}

function extractVideoUrl(result) {
  return result?.video?.url || result?.video_url || result?.videos?.[0]?.url || null;
}

async function pollFalJob(requestId, apiKey) {
  const statusUrl = `https://queue.fal.run/${FAL_MODEL}/requests/${requestId}/status`;
  const resultUrl = `https://queue.fal.run/${FAL_MODEL}/requests/${requestId}`;
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const r = await fetch(statusUrl, { headers: { Authorization: `Key ${apiKey}` } });
    const data = await r.json().catch(() => ({}));
    if (data.status === 'COMPLETED') {
      const rr = await fetch(resultUrl, { headers: { Authorization: `Key ${apiKey}` } });
      const result = await rr.json().catch(() => ({}));
      const videoUrl = extractVideoUrl(result);
      if (!videoUrl) throw new Error('fal.ai completed but no video URL was found in the result: ' + JSON.stringify(result).slice(0, 300));
      return videoUrl;
    }
    if (data.status === 'ERROR' || data.status === 'FAILED') throw new Error('fal.ai generation failed: ' + (data.error || data.status));
    await new Promise(res => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error('fal.ai generation timed out after 5 minutes.');
}

// Cached to assets/broll/<tag>.mp4 — same location/convention Pexels/Pixabay use, so a render
// started right after this completes finds it via the normal local-file lookup in
// lib/assets.js's resolveBroll, no separate "AI broll" code path needed at render time.
async function generateAiBroll(job, env) {
  const { spec } = job;
  const apiKey = spec.client_keys?.fal_api_key;
  if (!apiKey) throw new Error('fal.ai requires a client-supplied API key.');
  if (!spec.tag || !spec.prompt) throw new Error('tag and prompt are required.');
  const aspectMap = { '9:16': '9:16', '1:1': '1:1', '16:9': '16:9' };
  const requestId = await submitFalJob(spec.prompt, apiKey, aspectMap[spec.target_aspect] || '9:16');
  const videoUrl = await pollFalJob(requestId, apiKey);
  const assetsRoot = env.ASSETS_ROOT || path.join(__dirname, '..', 'assets');
  const destPath = path.join(assetsRoot, 'broll', `${spec.tag}.mp4`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await downloadToFile(videoUrl, destPath);
  return { tag: spec.tag };
}

module.exports = { generateAiBroll };
