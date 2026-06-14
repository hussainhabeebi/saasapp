# Leadvyne — client provisioning

Login-gated front-end that provisions a WhatsApp bot client end to end: writes the config and
**creates + activates a dedicated bot workflow on your n8n via its API**. Each client gets a thin
wrapper that calls one shared engine — so you fix logic in one place and clients never drift.

## Contents
```
frontend/index.html        ← login + onboarding UI (static site)
Dockerfile                 ← serves the UI via nginx (Coolify-ready)
n8n/onboard.json           ← passcode gate → write client → create+activate wrapper via n8n API
n8n/engine.json            ← shared engine sub-workflow (text/voice/image, intent, flow)
n8n/followup-template.json ← clone per client for scheduled nudges
SETUP.md                   ← full step-by-step (read this first)
```

## Quick start
1. Read **SETUP.md**.
2. Create the NocoDB **clients** table (schema in SETUP).
3. n8n → Settings → create an **API key**; save it as a Header Auth credential `X-N8N-API-KEY`.
4. Import `engine.json`, set its placeholders, copy its workflow id.
5. Import `onboard.json`, set passcode + engine id + clients-table ids + the n8n API credential, activate.
6. Deploy `frontend/` (Coolify uses the Dockerfile) and open it.
7. Enter the passcode, fill the form, **Provision client**, paste the returned URL into Chatwoot.

## How it works
- **One engine** holds all logic. **Per-client wrappers** are 4-node workflows the onboard flow
  stamps out via the n8n API — they never change, so there's nothing to drift.
- **Tenant tokens** are injected into HTTP headers from the client's config row, so one engine
  serves everyone without per-client n8n credentials. The only fixed credentials are the master
  NocoDB token (reads the clients table) and the n8n API key (creates wrappers).
- **Media:** text, image (Gemini vision), voice (download + transcribe).

`engine.json` is a working foundation — test the media branches once in n8n and swap the
transcription node for your STT if WhatsApp's ogg audio isn't accepted by your model.
