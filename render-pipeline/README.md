# LeadVyne voice service

This Coolify service is the voice-only replacement for the retired Marketing Studio render
pipeline. It preserves the existing public base URL and `RENDER_WEBHOOK_SECRET`, so Cloudflare
Worker and backend recovery settings do not need to change.

## Endpoints

- `GET /health` — build, AI4Bharat readiness, pending summary jobs and Piper readiness.
- `POST /tts-jobs` — end-of-session voice summary. Body `{job_id, text, language, callback_url}`;
  returns `202` at once. Jobs run one at a time: AI4Bharat Indic Parler-TTS
  (`ai4bharat/indic-parler-tts`, Malayalam/Hindi, no time limit) first, Piper as backup. The result
  `{job_id, ok, provider, audio_base64, error}` is POSTed to `callback_url`, signed the same way.
- `POST /synthesize-voice-reply` — AI4Bharat Indic Parler-TTS to Ogg/Opus (Malayalam/Hindi).
- `POST /synthesize-piper-tts` — lightweight local Piper voices (English/Malayalam/Hindi).
- `POST /pcm-to-ogg` — PCM conversion retained for the voice integration.

All POST endpoints require `X-Signature`, calculated as base64 HMAC-SHA256 of the exact JSON body
using `RENDER_WEBHOOK_SECRET`.

## Coolify

Build from `render-pipeline/Dockerfile` and configure:

- `RENDER_WEBHOOK_SECRET` — required; keep the current value.
- Keep the Coolify build argument `INSTALL_AI4BHARAT_TTS=false` (the default) on the current VPS.
  This deploys the fast Piper service without building multi-GB PyTorch/model layers.
- `AI4BHARAT_TTS_ENABLED=false` — runtime switch for the standard lightweight deployment.
- `AI4BHARAT_STARTUP_TIMEOUT_MS=300000` — one-time Parler model preload ceiling.
- `PARLER_VOICE_ML` / `PARLER_VOICE_HI` — optional voice descriptions; defaults use the model
  card's named speakers Anjali (Malayalam) and Divya (Hindi).
- `AI4BHARAT_RESTART_COOLDOWN_MS=60000` — prevents repeated heavy reloads after a timeout.
- `PIPER_TTS_TIMEOUT_MS=2500` — kills a stuck Piper process before it can hold the VPS.
- `HF_TOKEN` — build variable if Hugging Face requires access.
- `PORT=8787` — optional; this is the default.

To run Indic Parler-TTS (about 4 GB of weights, 6-8 GB RAM; a GPU is used automatically when
present), rebuild the service with the build argument `INSTALL_AI4BHARAT_TTS=true` and set the
runtime variable `AI4BHARAT_TTS_ENABLED=true`. Without it, `/tts-jobs` still works using Piper
only, and `/synthesize-voice-reply` returns HTTP 503.

The former video renderer, Remotion/Chromium, image studio, transcription and storage upload
features have been removed. Existing D1 migration history is intentionally retained so deployed
databases remain compatible; the old `/marketing/*` Worker APIs now return HTTP 410.

When installed and enabled, the Python model process starts with the container and remains warm.
`/health` reports both `ai4bharat_tts_installed` and `ai4bharat_model_ready`; do not send
AI4Bharat production traffic until both are `true`.
