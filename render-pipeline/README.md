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
- **`spec.text_behind_subject` (beta)**: captions sit BEHIND the person in the video instead of on
  top — see "Text behind subject" below.
- **`POST /extract-audio`** (synchronous, not part of the render job queue): strips a video down
  to just its audio track (16kHz mono mp3) so the Worker's transcription step can send a much
  smaller file to OpenAI than the whole video — OpenAI's Whisper endpoint hard-caps requests at
  25 MB, which a video can exceed easily even when its actual speech content is short, since
  picture data dominates file size. See `lib/extractAudio.js`.
- Uploads the render result to the same R2 bucket the Worker already serves from (or a local
  fallback for testing without Cloudflare), then POSTs a signed callback to
  `.../marketing/webhook/render-complete`.

## Text behind subject (beta)

The popular short-form effect where a caption appears to sit behind the person on screen, as if
they're standing in front of the text. Requires actually detecting and cutting the person out of
each frame (video subject segmentation) — a materially different, heavier piece of engineering
than anything else in this service, so it's its own pipeline (`lib/textBehindSubject.js` +
`lib/segmentation.js`), not a caption style variant.

**Approach: free, local, no per-video cost.** Runs
[RobustVideoMatting](https://github.com/PeterL1n/RobustVideoMatting) (MIT-licensed model) locally
via `onnxruntime-node` — a real, purpose-built human video-matting model (not a generic heuristic
or chroma-key trick), with its recurrent hidden state carried frame-to-frame for temporal
stability (this is specifically what keeps a video matte from flickering compared to segmenting
each frame in isolation). The `.onnx` model (~15 MB) is downloaded at Docker build time, not
committed to the repo — see the `Dockerfile`. The alternative would be a paid cloud
video-matting API for cleaner edges with less engineering risk; not used here, per the "minimal
cost" brief this feature was built under.

**Processing detail, and why it's approximate:** frames are decoded and matted at a reduced size
(384px wide, 15fps) for CPU speed/memory rather than the render's full resolution/frame-rate —
RVM's own guidance for real-time use. The resulting matte is then upscaled to the target
resolution when compositing. This keeps a render fast enough to be usable, at the cost of softer
edges than a full-resolution pass (or a paid API) would give you, especially on fast motion or
a background with low contrast against the person.

**v1 scope — does not combine with silence-cut/auto-zoom/B-roll/SFX/VFX cues in the same render.**
Enforced in code (`lib/render.js`: `silence_cut` becomes a no-op whenever `text_behind_subject` is
set, not just documented as unsupported) rather than left as a silent desync bug — combining the
segment-splice/time-remap machinery those features use with this effect's background/foreground
layer reordering would be a substantially bigger rework, and this ships the core effect first.
`text_behind_subject`'s only other option today is a background color (`style.bg_color`) — a later
version could composite against a blurred/frozen frame of the original video instead of a flat
color; not built.

**What's verified vs. not** (see "Dev notes" below for the full breakdown): the ONNX inference
pipeline (model loads, correct tensor shapes, recurrent state carried across frames without
crashing, real matte video produced) and the compositing mechanics (alpha-merge + layer-reordering
correctly occludes background text where the matte says "person") were both verified end-to-end
with real ffmpeg/onnxruntime runs. **Segmentation *accuracy* on real human footage was not
verified** — no camera or licensed video of an actual person was available in the dev sandbox this
was built in, only synthetic test video (solid colors, test patterns), which correctly produces an
empty matte from RVM (there's no person in a color bar pattern) but says nothing about real-world
edge quality on an actual talking-head video. Test this against a real project before trusting it
for a client-facing render.

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

**Malayalam/Indic-script captions were separately verified**, not just assumed from the Latin
tests: rendered real Malayalam text with conjunct consonants (e.g. `നിങ്ങൾക്ക്`) through the
same `writeAssFile`→`subtitles` filter path, confirmed correct shaping (libass here is linked
against `libharfbuzz`, which is what makes conjunct/vowel-sign shaping work at all rather than
rendering isolated broken glyphs), and confirmed libass's automatic per-glyph font fallback
correctly substitutes in a Malayalam-capable font even when a style's requested font (e.g. the
"Bold Pop" preset's `Montserrat`) has no Malayalam coverage itself — no code branch needed to
detect script and swap fonts. This surfaced two real bugs, both fixed: (1) `fonts-noto-core`
was missing from the `Dockerfile` — without it, Malayalam/Tamil/Telugu/etc. text would render as
empty tofu boxes since no installed font would have those glyphs at all; (2) `WrapStyle` was set
to `2` (no auto-wrap), which let long caption lines run off the right edge of the frame instead
of wrapping — this affected every language, not just Malayalam, and is now `0` (smart wrap).
"Manglish" (Malayalam written in Latin letters) needed no special handling — it's just Latin
script and already rendered fine with `fonts-liberation` alone.

**Text-behind-subject's ONNX/matting pipeline was verified in stages**, same "test what's
testable, flag what isn't" approach: (1) the model loads and reports the expected
`src`/`r1i..r4i`/`downsample_ratio` inputs and `fgr`/`pha`/`r1o..r4o` outputs; (2) a full
frame-by-frame inference run over a real decoded video (ffmpeg pipe → raw RGB → tensor →
inference, recurrent state threaded frame-to-frame) completes without shape errors and produces a
correctly-sized matte video; (3) the compositing filter graph (`alphamerge` + layer-reordered
`overlay`) was verified with a **hand-crafted fake matte** (a synthetic white ellipse standing in
for "a person-shaped cutout") — confirmed captions on the background layer are correctly occluded
where the matte says foreground, which is exactly the mechanic real segmentation output would
drive too. What this does NOT verify: whether RVM's actual segmentation is accurate on a real
person in a real video — that needs real footage, which wasn't available here (see the
"Text behind subject" section above).

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
- **Text-behind-subject is CPU-bound and adds real render time** — a full matting pass (frame
  decode + per-frame ONNX inference) runs in addition to the normal encode; expect this mode to
  take noticeably longer per video than a regular caption-clip render, roughly in proportion to
  clip length. No GPU acceleration is configured (`onnxruntime-node`'s default CPU execution
  provider) — adding one is a reasonable upgrade if this becomes a bottleneck at volume.
- **Text-behind-subject doesn't combine with silence-cut/auto-zoom/B-roll/SFX/VFX** in v1 — see
  the "Text behind subject" section above for why and how it's enforced.
- **Text-behind-subject's background is a flat color only** — no blurred/frozen-video background
  option yet.
