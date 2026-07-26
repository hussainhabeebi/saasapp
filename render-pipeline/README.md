# Marketing Studio render pipeline

The one piece the `cloudflare-worker/worker.js` Marketing Studio module deliberately doesn't do
itself, because Cloudflare Workers can't run ffmpeg: actually rendering a video (crop to aspect,
burn in captions, cut silences, auto-zoom, drop in B-roll/SFX/VFX cues, mix background music,
watermark). This is a small self-hosted Node + ffmpeg service that receives a signed render spec
from the Worker and calls back when it's done. See `SETUP.md`'s "Marketing Studio module" sections
for the full request/callback contract this implements.

## What it actually does

- **`spec.mode:'caption-clip'`** (a project rendered from an uploaded video): downloads the
  source, optionally detects and cuts silence (real `silencedetect` analysis, not a no-op flag),
  crops/scales to the target aspect, optionally applies a slow auto-zoom, burns in captions from
  an ffmpeg ASS subtitle file (word-highlight/pop/plain animations, matching the style presets in
  `worker.js`), composites any accepted B-roll/SFX/VFX cues it has a matching local asset for
  (B-roll as a corner picture-in-picture insert, SFX as a one-shot audio overlay, VFX as a
  filter-only flash/pulse effect — no asset needed for VFX), mixes in background music if a track
  is available, and watermarks free-tier exports.
- **`spec.mode:'template'`** (Video Templates batch generation): composites the already
  `{{variable}}`-resolved scenes (text cards / images) into one clip.
- Uploads the result to the same R2 bucket the Worker already serves from (or a local fallback for
  testing without Cloudflare), then POSTs a signed callback to
  `.../marketing/webhook/render-complete`.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `RENDER_WEBHOOK_SECRET` (must exactly match the
   Worker's `MARKETING_RENDER_WEBHOOK_SECRET`) and either the R2 credentials or the
   `LOCAL_PUBLIC_BASE_URL` fallback — see the comments in `.env.example`.
3. (Optional but recommended) Drop your own royalty-free B-roll/SFX/music into `assets/broll/`,
   `assets/sfx/`, `assets/music/` — see each folder's `README.md` for the exact filenames. Nothing
   breaks if you skip this; those cues/toggles are just silently no-ops without a matching file.
4. `npm start` (or deploy the `Dockerfile` — built and tested against `node:20-bookworm-slim` +
   `apt-get install ffmpeg fontconfig fonts-liberation`; on this repo's existing Coolify setup,
   point a new Coolify resource at this directory the same way `frontend/Dockerfile` and
   `backend/Dockerfile` are already deployed, and mount `/app/assets` + `/app/public` as
   persistent volumes so asset/output files survive a redeploy).
5. Set `MARKETING_RENDER_WEBHOOK_URL` on the Worker (`wrangler secret put`) to this service's
   public `/render` URL, and `MARKETING_RENDER_WEBHOOK_SECRET` to the same secret from step 2.

## Local testing without deploying anything

```
RENDER_WEBHOOK_SECRET=dev-secret LOCAL_PUBLIC_BASE_URL=http://localhost:8787/public npm start
```

Then POST a signed job at it yourself:

```js
const hmac = require('./lib/hmac');
const body = JSON.stringify({ job_id: 1, client_id: 1, project_id: 1,
  callback_url: 'https://your-worker.../marketing/webhook/render-complete',
  spec: { mode: 'caption-clip', source_url: '...', trim_start_sec: 0, trim_end_sec: 10,
    resolution: '1080x1920', captions: { words: [...] }, style: {...}, watermark: true } });
const signature = hmac.sign('dev-secret', body);
// POST to http://localhost:8787/render with header X-Signature: <signature>
```

## Dev notes — what's actually been verified vs. what's design-only

Every ffmpeg technique this service relies on (multi-segment `trim`+`concat` for silence-cut,
`zoompan` for auto-zoom, `subtitles` for ASS caption burn-in incl. `\k` karaoke word-highlight and
`\t` pop-scale, `overlay`+`enable` for B-roll PiP, `eq`+`enable` for the VFX flash, `adelay`+`amix`
for one-shot SFX, `volume`+`amix` for background music, the `concat` demuxer for template scenes)
was hand-run against real ffmpeg with synthetic test video/audio during development, not just
written and assumed to work — including the full combined pipeline (silence-cut segments + zoom +
B-roll + VFX + captions + watermark + music + SFX in one command) and the whole server end-to-end
(signed request in → queued → rendered → signed callback out, plus signature-rejection). What
was **not** verified in this environment: the actual `Dockerfile` build (no Docker daemon
available here) and a real video/transcript from the live Worker (only synthetic
`testsrc`/`sine`/solid-color inputs) — the pipeline's correctness on that is inference from the
underlying ffmpeg behavior being confirmed, not a substitute for testing it against a real
project once deployed.

## Known limitations

- **Background music ducking is constant-level, not sidechain-triggered** — see
  `assets/music/README.md`.
- **B-roll is a corner PiP overlay, not a full-screen cutaway** — a cutaway would need the same
  segment-splice/time-remap machinery silence-cut uses, extended to also carry captions/cues
  through the splice; PiP reaches the same "B-roll is visible for this cue" outcome without that
  complexity. See `SETUP.md`.
- **VFX `badge`/`split` cues render as a saturation/contrast pulse**, not literal badge artwork or
  an actual split-screen — there's no badge-art or second-camera-angle asset to composite with.
- **No queue persistence** — the in-process job queue (`server.js`) is memory-only; a process
  restart mid-batch drops whatever was still queued. Fine for the batch sizes Marketing Studio
  caps at (100 videos/generate call); would need a real queue (Redis/SQS/etc.) at higher volume.
- **Single-instance by design** — see `server.js`'s comment on why this doesn't horizontally scale
  as-is.
- **Fonts** are whatever fontconfig resolves on the container (Liberation family via
  `fonts-liberation`, substituting for Arial/Helvetica-named styles) — a style requesting a font
  that isn't installed silently falls back to fontconfig's default match rather than erroring.
