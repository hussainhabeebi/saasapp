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
  `worker.js`), composites any accepted B-roll/SFX/VFX cues (B-roll as a corner picture-in-picture
  insert, SFX as a one-shot audio overlay, VFX as a filter-only flash/pulse effect — no asset
  needed for VFX), mixes in background music if a track is available, and watermarks free-tier
  exports. B-roll resolves to a local file in `assets/broll/` if one's been dropped in for that
  cue's tag, **or automatically fetches a real royalty-free clip from Pexels** the first time that
  tag is used (`PEXELS_API_KEY`, `lib/assets.js`) — cached to `assets/broll/<tag>.mp4` afterward,
  so it's one API call per tag ever, not per render. SFX/music stay local-file-only (no free,
  redistributable stock audio API used here); a cue with neither a local file nor (for B-roll) a
  Pexels result is silently skipped, same as before.
- **`spec.mode:'template'`** (Video Templates batch generation): composites the already
  `{{variable}}`-resolved scenes (text cards / images) into one clip. Two engines share this mode:
  the default ffmpeg engine (static text/image scenes, described above) and the Remotion engine
  (`spec.engine:'remotion'` — real animated React compositions) — see "Animated templates
  (Remotion engine)" below.
- **`spec.text_behind_subject` (beta)**: captions sit BEHIND the person in the video instead of on
  top — see "Text behind subject" below.
- **`POST /extract-audio`** (synchronous, not part of the render job queue): strips a video down
  to just its audio track (16kHz mono mp3) so the transcription step can send a much smaller file
  to OpenAI than the whole video — OpenAI's Whisper endpoint hard-caps requests at 25 MB, which a
  video can exceed easily even when its actual speech content is short, since picture data
  dominates file size. See `lib/extractAudio.js`.
- **`POST /transcribe`** (synchronous): extracts audio (reuses `extractAudio()`) and calls
  OpenAI's Whisper API **from this server**, not from the Worker. This matters, not just tidiness:
  OpenAI blocks requests whose source IP resolves to certain countries/regions, and Cloudflare
  Workers' globally-distributed edge network has an unpredictable egress IP per request — calling
  OpenAI directly from `worker.js` hit exactly that block ("Country, region, or territory not
  supported") for a real project, even though the account's actual location is fine. This server
  runs on one fixed host, so its egress IP is stable. `MARKETING_TRANSCRIBE_API_KEY` now lives
  here (`.env`/Coolify env var), not as a Worker secret — see `lib/transcribe.js`. `worker.js`
  falls back to calling OpenAI directly (old behavior) when this service isn't configured, so
  transcription still works without it, just subject to both the 25 MB cap and the country-block
  risk.
- **`POST /detect-scenes`** (synchronous): real shot/cut detection — ffmpeg's built-in
  `select='gt(scene,0.3)'` filter piped through `showinfo` scores each frame's visual difference
  from the previous one and logs a `pts_time` for every frame crossing the threshold, i.e. every
  detected cut (same stderr-scraping pattern as `lib/timeline.js`'s silence detection, not a
  separate detection library). Cuts closer together than 0.75s are merged into one boundary — real
  footage can otherwise fire twice for what's really one hard cut a couple of frames apart. See
  `lib/sceneDetect.js`. Verified against real synthetic test videos: a 3-scene clip (distinct
  solid colors, cuts at exactly 3s/6s) detected both cuts precisely; a no-cut clip correctly
  returned one scene; a clip with a 0.2s sliver scene correctly merged it into its neighbor. Used
  by the Worker's `/marketing/projects/detect-scenes` to group the caption editor's word list by
  scene instead of one flat block, and to power "split evenly" — re-distributing a scene's words
  evenly across *that scene's* duration specifically, not the whole clip, when a transcription
  provider only returned one coarse chunk covering a whole scene (a real accuracy improvement over
  the existing clip-wide approximate-timing fallback). Also generates one small (240px) JPEG
  thumbnail per scene (`generateSceneThumbnails`, captured slightly into the scene rather than at
  the exact cut frame, to avoid transition/motion blur) and uploads them via the same
  `uploadOutput` helper renders use — verified end-to-end against a live server: real scene
  detection + real thumbnail generation + real HTTP serving of the resulting JPEGs, both with R2
  and with the local-fallback mode. Powers the Editor's scene thumbnail strip and timeline.
- **`POST /concat-clips`** (synchronous): stitches several uploaded clips into one combined video
  for Marketing Studio's multi-clip projects — normalizes each clip to the target resolution first
  (clips can come from different cameras/resolutions/codecs), then concatenates via the `concat`
  *filter* (re-encodes) rather than the stream-copy `concat` demuxer, which is what makes
  mismatched inputs work at all. Verified with two clips of genuinely different resolutions
  (640×480 and 1080×1920) producing one correctly-normalized combined output. See
  `lib/concatClips.js`.
- **Export quality** (`spec.quality`: `draft`/`standard`/`high`) — `QUALITY_PRESETS`
  (`lib/filtergraph.js`) maps to real `-crf`/`-preset` values, shared by all three render modes
  (caption-clip, template, text-behind-subject) so quality is consistent regardless of which
  pipeline a project ends up using.
- Uploads the render result to the same R2 bucket the Worker already serves from (or a local
  fallback for testing without Cloudflare), then POSTs a signed callback to
  `.../marketing/webhook/render-complete`.

## Self-hosted transcription (`WHISPER_LOCAL_ENABLED`, `asr/transcribe.py`, `lib/whisperTranscribe.js`)

Opt-in (off by default). Requested as "add whisperX + AI4Bharat" — what's actually here is
`faster-whisper` instead, after real testing found: whisperX's own package fails to install
(hard-depends on `pyannote.audio` for diarization, unused here, which pulls in
`antlr4-python3-runtime`, whose sdist build fails against current setuptools), and AI4Bharat's
Tamil/Malayalam wav2vec2-alignment model coverage couldn't be confirmed to exist (only Hindi/
Odia/Bengali/Telugu were). `faster-whisper` — the same engine whisperX itself uses for the
transcription stage — installs cleanly and has its own built-in `word_timestamps` (DTW-based, no
separate per-language model needed), covering every language uniformly. Provider order in
`lib/transcribe.js`: `WHISPER_LOCAL_ENABLED` → Sarvam (its supported languages) → OpenAI Whisper
API. See SETUP.md's "Self-hosted transcription" section for the full detail, including exactly
what was verified (clean pip install, every parsed field name confirmed against the installed
package directly) vs. not (actual model download+inference — this dev sandbox's proxy blocks
huggingface.co).

## Self-hosted transcription — AI4Bharat (`AI4BHARAT_ENABLED`, `asr/transcribe_ai4bharat.py`, `lib/ai4bharatTranscribe.js`)

Opt-in, added after the above — the user confirmed AI4Bharat specifically ("AI4Bharat is fine,
dont use whisperX if its heavy"). Uses `ai4bharat/indic-conformer-600m-multilingual`, a
600M-parameter Conformer covering all 22 official Indian languages including Tamil/Malayalam
(confirmed via the model card — unlike the earlier `IndicWav2Vec` models, only confirmed for
Hindi/Odia/Bengali/Telugu). REPLACES Sarvam for the ~10 languages it's wired up for
(`lib/transcribe.js`'s provider order: `WHISPER_LOCAL_ENABLED` → `AI4BHARAT_ENABLED` → Sarvam →
OpenAI Whisper) — no chunking/offset arithmetic needed (single whole-clip call, no per-request
duration cap), removing the class of bug Sarvam's chunking introduced. **Real, honest cost**:
`transformers`+`torch`+`torchaudio` (CPU wheel) measured ~1.2GB — heavier than faster-whisper's
~150-200MB, but installs cleanly (the CPU-only PyTorch index in the Dockerfile is load-bearing —
the default `pip install torch` pulls the full CUDA toolkit, 5GB+, confirmed in testing). **The
one real gap**: this model's documented interface returns plain text only, no word-level
timestamps — genuinely improves recognized text for Indic languages, but word timing still falls
back to the same evenly-split approximation used elsewhere in this app. See SETUP.md for full
detail on what was verified vs. not.

**Needs `HF_TOKEN`** — this specific model repo is GATED on Hugging Face (a real `401
GatedRepoError` hit on the first build attempt, not documented anywhere findable beforehand).
Requires an HF account that's clicked "Agree and access repository" on the model's page, plus a
read-scoped token passed as the `HF_TOKEN` Docker build arg (Coolify build-time variable, not a
runtime env var — the model is downloaded and baked in at build time). The Dockerfile's
pre-download step skips gracefully (clear message, doesn't fail the whole build) when `HF_TOKEN`
isn't set, so this only matters if you're actually turning `AI4BHARAT_ENABLED` on.

## Sarvam AI transcription for Indic languages (`SARVAM_API_KEY`, `lib/sarvamTranscribe.js`)

Whisper's real-world Malayalam accuracy turned out to be weak — a real project's Malayalam audio
came back mislabeled/garbled through OpenAI's API. When `SARVAM_API_KEY` is set and a project is
explicitly tagged with a language Sarvam supports (`hi`/`bn`/`kn`/`ml`/`mr`/`or`/`pa`/`ta`/`te`/
`gu`/`en`), `lib/transcribe.js` routes to Sarvam instead of Whisper for that request. No language
tag at all still goes to Whisper — there's nothing to route on ahead of time.

**Why this needed real engineering, not a drop-in swap:** Sarvam's word-timestamp REST endpoint
caps a single request at 30 seconds of audio — a real video needs chunking first. This reuses the
app's own silence detection (`lib/timeline.js`, already built for silence-cut) to prefer cutting
chunks at quiet moments instead of mid-word, calls Sarvam once per chunk, and stitches the results
back into one timeline by offsetting each chunk's word times by its start offset in the full
audio — normalized to the exact same `{language, text, words:[{word,start,end}]}` shape Whisper's
path already returns, so nothing downstream (the Worker, the caption editor) needed to change.

**What's verified vs. not.** The chunking/stitching mechanics were verified for real: a real
33-second synthetic audio clip with a silence gap was run through the actual chunk-planning and
ffmpeg-splitting code, confirming it correctly split at the silence gap, called the (mocked)
Sarvam endpoint once per chunk, and stitched word offsets back into one correct timeline —
including a mixed-shape test where one mocked chunk returned parsed word timestamps and the other
didn't, confirming the approximate-timing fallback (see below) fires correctly per chunk. What's
**not** verified: the actual Sarvam response JSON's field names for word-level timestamps.
Sarvam's own docs site (docs.sarvam.ai) blocks automated fetches (bot protection, HTTP 403 to
every attempt), and no live `SARVAM_API_KEY` was available in the dev sandbox this was built in to
test against the real API. The request side (endpoint, `api-subscription-key` auth header,
multipart fields, `with_timestamps`) is high-confidence — the auth header matches this app's
existing, working Sarvam TTS integration (`engineSarvamTts` in `worker.js`), and the rest was
corroborated across several independent sources. `parseSarvamWords()` defensively tries a couple
of plausible response shapes and falls back to evenly-split timing (flagged `approximate:true`,
same convention as Whisper's segments-only fallback) rather than crashing if none match — so a
wrong guess degrades to less-precise caption timing, it doesn't break transcription outright.
**Test against a real Malayalam project once deployed**; if every word comes back
`approximate:true`, the real response shape differs from every candidate tried here — paste a raw
Sarvam response and the parser can be corrected in one place (`parseSarvamWords`).

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

## Animated templates (Remotion engine)

`worker.js`'s Video Templates library has two kinds of templates now: the default ffmpeg engine
(static text/image "scenes", composited in order — described above) and a **Remotion** engine for
real animated compositions — spring/interpolate-driven motion (a pulsing discount badge, a
ticking countdown, an animated name+tagline reveal) rendered by driving actual headless Chrome
through [Remotion](https://www.remotion.dev/), not ffmpeg text overlays. This is the
"template/style layer" split: Remotion owns animated template compositions specifically; the
caption burn-in for uploaded videos (`spec.mode:'caption-clip'`) and transcription remain
ffmpeg/libass and Whisper, unchanged.

- **`remotion/`** — the composition source. `remotion/compositions/*.jsx` are the actual React
  components (`FlashSale`, `ProductLaunch`, `Countdown`, `Testimonial`); `remotion/Root.jsx`
  registers each as a `<Composition>` with its id, fixed `durationInFrames`/fps, and
  `defaultProps` — this registry is the single source of truth for composition ids, and must stay
  in sync with `worker.js`'s `MARKETING_REMOTION_LIBRARY` (id, target aspect, prop schema for the
  picker UI). `remotion/index.jsx` is the bundler entry point (`registerRoot`).
- **`lib/remotionRender.js`** — the orchestrator `server.js` dispatches to whenever
  `spec.engine==='remotion'`: bundles the `remotion/` tree once per process (webpack, ~10s, cached
  in `bundlePromise` — not redone per render), `selectComposition()`s the requested id with the
  job's `spec.props` as `inputProps`, `renderMedia()`s it to an MP4 at the project's target
  resolution (overriding the composition's registered default width/height), optionally burns in
  the "Made with Leadvyne" watermark with a plain ffmpeg `drawtext` pass (same as the ffmpeg
  engine's watermark), then uploads to R2 same as any other render.
- A template using this engine has `engine:'remotion'` + `remotion_composition_id` set instead of
  `scenes` (`marketing_templates.engine`/`.remotion_composition_id`/`.props_schema_json`, added in
  migration `0019_marketing_remotion.sql`); `spec.props` (the batch-generate row's variables) are
  passed straight through as the composition's React props — no `{{variable}}` string substitution
  like the ffmpeg engine, since Remotion components consume props natively.
- **Requires real headless Chrome in the container** (`@remotion/renderer` drives it directly, not
  a lighter headless-browser shim) — see the `Dockerfile`'s Chrome runtime dependencies
  (`libnss3`, `libgbm1`, etc.) and its `npx remotion browser ensure` build step, which downloads
  Chrome Headless Shell once at image build time rather than on the first production render.

**What's verified vs. not:** the full bundle→selectComposition→renderMedia pipeline was run for
real (not just written) — two compositions (`FlashSale` with watermark+resolution-override,
`Countdown` without) rendered to real playable MP4s and individually confirmed correct via
extracted frames (e.g. `Countdown`'s ticking-hours math checked against the expected value at a
specific frame). What was **not** verified: the `Dockerfile`'s `npx remotion browser ensure` step
and the container's Chrome runtime deps (no Docker daemon in the dev sandbox this was built in —
same limitation noted below for the rest of the `Dockerfile`); local verification instead pointed
`REMOTION_BROWSER_EXECUTABLE` at a pre-installed Chromium in that sandbox, which is not how the
deployed container resolves its browser (it relies on the build-time `ensure` step finding its own
downloaded copy) — test a real render against the deployed container once redeployed.

## Client-level API keys, more free sources & AI B-roll

- **Client-level keys**: every external source below can be configured per-client (Marketing
  Studio's 🔑 API Keys tab, backed by `marketing_client_settings`) instead of only a shared
  server env var. `lib/assets.js`'s `apiKeyFor(field, env, clientKeys, envVarName)` is the single
  precedence point — `clientKeys?.[field] || env?.[envVarName]` — used by every fetch function
  below, so a client's own key always wins over the shared default when set.
- **Pixabay** (`fetchFromPixabay`, `PIXABAY_API_KEY`) — second free B-roll source, tried when
  Pexels has no key or no result for a tag. Auth via `key=` query param; picks the largest
  available quality tier from `hits[0].videos`.
- **Freesound.org** (`fetchFromFreesound`, `FREESOUND_API_KEY`) — free SFX auto-fetch, mirroring
  the existing B-roll auto-fetch. Auth via `token=` query param; uses **preview** files only
  (`previews['preview-hq-mp3']`), which — confirmed against Freesound's own docs — need no OAuth2,
  unlike the full-quality Download endpoint. Free key, instant issue, at
  freesound.org/apiv2/apply.
- **Filler-word removal** (`lib/fillerWords.js`) — `spec.filler_word_cut` reuses
  `lib/timeline.js`'s existing `computeKeepSegments`/`makeTimeMapper` (a cut range is a cut range,
  regardless of whether it came from silence-detection or a filler word), merging filler-word
  ranges in alongside silence ranges before the single remap pass in `render.js`, and also filters
  filler words out of the caption word list itself. `FILLER_WORDS` is a small English-only set —
  does **not** cover Malayalam or other non-English filler words, a real gap, not attempted here.
- **AI B-roll generation via fal.ai** (`lib/falBroll.js`, `spec.mode:'ai-broll'`) — **paid**,
  unlike everything else on this page (roughly $0.05–$0.40/sec depending on model). Requires a
  **client-supplied** `spec.client_keys.fal_api_key` — no shared server default for this one, so a
  client's generation spend always bills to their own fal.ai account. Runs as its own job on the
  exact same queue/HMAC-callback machinery as a real render (`server.js`'s
  `job.spec?.mode === 'ai-broll'` branch), not new infrastructure. Submits to fal.ai's queue API
  (`POST https://queue.fal.run/fal-ai/wan/v2.7/text-to-video`, `Authorization: Key <key>`), then
  **polls** the status endpoint every 5s for up to 5 minutes (polling chosen over fal.ai's webhook
  option specifically to avoid standing up a new public inbound endpoint + signature verification
  for this one feature). Result is downloaded and cached to `assets/broll/<tag>.mp4` — the exact
  same path convention Pexels/Pixabay already use, so a render started right after generation
  completes finds it through the normal local-file lookup in `resolveBroll`, with no separate "AI
  broll" code path at render time.
  **What's verified vs. not**: the queue submit/status endpoints, the `Authorization: Key <key>`
  header, and the poll-vs-webhook tradeoff are confirmed against fal.ai's own documentation. The
  exact result payload field (`result.video.url`, read by `extractVideoUrl()`) is corroborated
  only by third-party docs/code-examples quoting this model's API, not fal's own docs directly, and
  was **not** tested against a real fal.ai key (none was available in the dev sandbox this was
  built in) — if a real generation completes but the expected field isn't found, the thrown error
  includes the actual response so the field name can be corrected in one place. Test with a real
  fal.ai key after deploying before relying on this.

## CapCut-style extras (speed ramp, denoise, chroma key, auto-reframe, beat sync, TTS)

All free — no paid API involved, unlike the fal.ai section above.

- **`lib/filtergraph.js`** gained `denoise`, `chromaKey`, `speedFactor`, and `cropXExpr` params.
  Order matters: chroma key runs right after the crop step, denoise runs on the speech track
  before music/SFX mixing, and the speed ramp (`setpts`/`atempo`) runs LAST — after captions are
  already burned in and audio already mixed, so both just play back faster/slower together with no
  caption-timing recomputation needed. Hex colors are re-validated here (`sanitizeHexColor`) even
  though the Worker already validates them — defense in depth, since they're interpolated straight
  into an ffmpeg filter expression string.
- **`lib/autoReframe.js`** (smart auto-reframe) — reuses `lib/segmentation.js`'s RVM matting
  (now also exporting `decodeRawFrames`/`runMatting`/`PROC_WIDTH`/`PROC_FPS` for this to reuse
  directly, not re-run) to compute a per-frame subject centroid, smooths it, and builds a `crop`
  filter `x` expression in terms of ffmpeg's own `in_w`/`out_w` runtime variables — resolution-
  independent, no baked-in pixel math needed at expression-build time. `render.js` calls this
  BEFORE `buildFfmpegArgs` (which stays a pure "spec in, argv out" function, unchanged in spirit)
  and passes the resulting expression string in as `cropXExpr`. Best-effort: any failure (missing
  RVM model file, decode error, no confident subject) falls back to the plain center-crop rather
  than failing the render.
- **`lib/beatDetect.js`** (beat-synced cuts) — a from-scratch energy-onset detector: decodes PCM
  via the ffmpeg binary (no new npm dependency), computes short-time RMS energy, a spectral-flux-
  style novelty function (half-wave-rectified frame-to-frame energy increase), and adaptive-
  threshold local-maxima peak-picking. Explicitly NOT a tempo/BPM beat-tracker (no grid-fitting or
  phase estimation) — this finds energy onsets, which is what "cut on the beat" actually needs.
  `render.js` detects beats in the resolved background-music file, tiles the pattern across the
  full output duration (matching how the music loops via `-stream_loop -1`), and snaps each
  B-roll/SFX cue's start time to its nearest beat within 0.35s (leaving cues with no nearby beat
  untouched, so a keyword-timed cue that's correctly synced to speech isn't forced onto an
  unrelated beat).
- **`lib/tts.js`** (AI voiceover/dubbing, beta) — espeak-ng, apt-installable (added to the
  `Dockerfile`), no API key, fully offline. Maps this app's existing language codes to espeak-ng
  voices where one exists; falls back to `en-us` otherwise (e.g. Malayalam — espeak-ng has no
  Malayalam voice at all, so this produces English-accented speech, not silence or an error).
  Served synchronously from `server.js`'s new `POST /synthesize-voiceover` (same HMAC-signed
  pattern as `/transcribe`/`/detect-scenes` — synthesis is fast enough not to need the async job
  queue a full render uses), uploaded via the existing `uploadOutput` helper (`audio/mpeg`
  content-type, alongside its existing `video/mp4`/`image/jpeg` uses).
- **Social caption + hashtags** and **auto-translate captions** live entirely in `worker.js` (no
  render-pipeline changes) — the former reuses the existing shared `GEMINI_API_KEY`/
  `engineGeminiGenerate`, the latter calls MyMemory Translation API directly from the Worker (no
  key needed at all). See SETUP.md's "CapCut-style extras" section for the full detail on both,
  including exactly what was and wasn't verified for each (translation in particular: the
  MyMemory request/response contract is confirmed from its own docs, not a live call, since this
  dev sandbox proxies/blocks arbitrary outbound hosts).
- **What's verified vs. not**: the full combined filter graph (chroma key + denoise + 1.5× speed
  together) was run through real ffmpeg against synthetic video and confirmed correct (exact
  expected output duration). The auto-reframe crop expression was verified both standalone and
  inside the full filter graph against real ffmpeg with a synthetic moving-subject centroid track.
  Beat detection was verified against a real synthetic 16-click audio track (ffmpeg-generated),
  correctly finding 15/16 clicks (missing only the very first onset at t=0, an expected onset-
  detector characteristic, not a bug). The TTS pipeline (espeak-ng → ffmpeg mp3 encode) was run
  end-to-end for real, producing a correctly-sized, correct-duration audio file. **Not verified**:
  any of this against a real deployed container (no Docker daemon in this dev sandbox — same
  standing limitation noted elsewhere in this file), and MyMemory's live response shape (network
  access to arbitrary external hosts is proxied/blocked in this sandbox).

## Custom caption fonts (`fonts/`)

Drop a `.ttf`/`.otf` in `fonts/` (mount as a persistent volume — see the `Dockerfile`'s `VOLUME`
line) and it's usable in a caption style's `font` field on the very next render, no rebuild. Wired
via ffmpeg's own `subtitles` filter `fontsdir` option (`lib/filtergraph.js`'s step 6, and
`lib/textBehindSubject.js`'s separate subtitles call for that pipeline) — libass reads the
directory straight off disk at render time, no fontconfig/`fc-cache` registration needed. Verified
for real: a font file placed only in a scratch directory (not anywhere fontconfig would normally
scan) was correctly used to render real, non-tofu text through actual ffmpeg, both as a standalone
filter and combined into the full filter graph. See `fonts/README.md` for the workflow (find the
font's own internal family name, not its filename) and a few suggested free/open-license Malayalam
typefaces (not bundled here — download and drop in yourself).

## Deploy-state diagnostics (`GET /health`)

Returns `{ok, build, espeak_ng_available, rvm_model_present}` — `build` is a hand-bumped tag kept
in sync with `worker.js`'s `MARKETING_BUILD_TAG` (no shared source, two separately-deployed
services); the other two are REAL checks of this running container (`spawnSync('espeak-ng', ...)`,
`fs.existsSync(MODEL_PATH)`), not just "the process is up" — both depend on Dockerfile steps that
only run on an actual image rebuild, so this is the fast way to confirm a Coolify "redeploy"
really rebuilt the image instead of restarting a stale one.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `RENDER_WEBHOOK_SECRET` (must exactly match the
   Worker's `MARKETING_RENDER_WEBHOOK_SECRET`) and either the R2 credentials or the
   `LOCAL_PUBLIC_BASE_URL` fallback — see the comments in `.env.example`. Optionally also set
   `PEXELS_API_KEY`/`PIXABAY_API_KEY`/`FREESOUND_API_KEY` as shared defaults (clients can still
   override with their own key per-client — see "Client-level API keys" above); `fal.ai` has no
   shared-default env var by design, it's client-key-only.
3. (Optional but recommended) Drop your own royalty-free B-roll/SFX/music into `assets/broll/`,
   `assets/sfx/`, `assets/music/` — see each folder's `README.md` for the exact filenames. Nothing
   breaks if you skip this; those cues/toggles are just silently no-ops without a matching file
   (or fall back to Pexels/Pixabay/Freesound above, if a key is configured).
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
- **The Remotion engine meaningfully increases image size and build time** — a real Chrome
  Headless Shell download plus its runtime dependencies, on top of everything else already in the
  image. Only pay this cost if animated templates are actually used; the ffmpeg-engine templates
  and caption-clip pipeline don't touch Chrome at all.
- **Remotion renders are CPU-bound like everything else here** — same single-instance, no-GPU
  reasoning as the rest of this service; a batch of animated-template videos queues and renders
  one at a time same as any other job.
