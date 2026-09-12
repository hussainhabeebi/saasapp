# LeadVyne voice service

This Coolify service is the voice-only replacement for the retired Marketing Studio render
pipeline. It preserves the existing public base URL and `RENDER_WEBHOOK_SECRET`, so Cloudflare
Worker and backend recovery settings do not need to change.

## Endpoints

- `GET /health` — build, AI4Bharat concurrency and Piper readiness.
- `POST /synthesize-voice-reply` — AI4Bharat Indic Parler-TTS to Ogg/Opus.
- `POST /synthesize-piper-tts` — lightweight local Piper first tier (English/Malayalam/Hindi).
- `POST /pcm-to-ogg` — PCM conversion retained for the voice integration.

All POST endpoints require `X-Signature`, calculated as base64 HMAC-SHA256 of the exact JSON body
using `RENDER_WEBHOOK_SECRET`.

## Coolify

Build from `render-pipeline/Dockerfile` and configure:

- `RENDER_WEBHOOK_SECRET` — required; keep the current value.
- Keep the Coolify build argument `INSTALL_AI4BHARAT_TTS=false` (the default) on the current VPS.
  This deploys the fast Piper service without building multi-GB PyTorch/model layers.
- `AI4BHARAT_TTS_ENABLED=false` — runtime switch for the standard lightweight deployment.
- `AI4BHARAT_TTS_TIMEOUT_MS=6500` — live synthesis safety ceiling.
- `AI4BHARAT_STARTUP_TIMEOUT_MS=180000` — one-time model preload ceiling.
- `AI4BHARAT_RESTART_COOLDOWN_MS=60000` — prevents repeated heavy reloads after a timeout.
- `PIPER_TTS_TIMEOUT_MS=2500` — kills a stuck Piper process before it can hold the VPS.
- `HF_TOKEN` — build variable if Hugging Face requires access.
- `PORT=8787` — optional; this is the default.

To run AI4Bharat on a separate machine with enough RAM/disk (preferably a GPU), rebuild that
service with the build argument `INSTALL_AI4BHARAT_TTS=true` and set the runtime variable
`AI4BHARAT_TTS_ENABLED=true`. The lightweight image returns HTTP 503 immediately for AI4Bharat,
allowing the Worker to continue to the limited Sarvam and text fallbacks without loading Python.

The former video renderer, Remotion/Chromium, image studio, transcription and storage upload
features have been removed. Existing D1 migration history is intentionally retained so deployed
databases remain compatible; the old `/marketing/*` Worker APIs now return HTTP 410.

When installed and enabled, the Python model process starts with the container and remains warm.
`/health` reports both `ai4bharat_tts_installed` and `ai4bharat_model_ready`; do not send
AI4Bharat production traffic until both are `true`.
