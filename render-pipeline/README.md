# LeadVyne voice service

This Coolify service is the voice-only replacement for the retired Marketing Studio render
pipeline. It preserves the existing public base URL and `RENDER_WEBHOOK_SECRET`, so Cloudflare
Worker and backend recovery settings do not need to change.

## Endpoints

- `GET /health` — build, AI4Bharat concurrency and Piper readiness.
- `POST /synthesize-voice-reply` — AI4Bharat Indic Parler-TTS to Ogg/Opus.
- `POST /synthesize-piper-tts` — lightweight local Piper fallback.
- `POST /pcm-to-ogg` — PCM conversion retained for the voice integration.

All POST endpoints require `X-Signature`, calculated as base64 HMAC-SHA256 of the exact JSON body
using `RENDER_WEBHOOK_SECRET`.

## Coolify

Build from `render-pipeline/Dockerfile` and configure:

- `RENDER_WEBHOOK_SECRET` — required; keep the current value.
- `AI4BHARAT_TTS_ENABLED=true` — enables AI4Bharat synthesis.
- `AI4BHARAT_TTS_TIMEOUT_MS=20000` — subprocess safety ceiling.
- `AI4BHARAT_STARTUP_TIMEOUT_MS=180000` — one-time model preload ceiling.
- `HF_TOKEN` — build variable if Hugging Face requires access.
- `PORT=8787` — optional; this is the default.

The former video renderer, Remotion/Chromium, image studio, transcription and storage upload
features have been removed. Existing D1 migration history is intentionally retained so deployed
databases remain compatible; the old `/marketing/*` Worker APIs now return HTTP 410.

The Python model process starts with the container and remains warm. `/health` reports
`ai4bharat_model_ready`; do not send production traffic until it is `true`.
