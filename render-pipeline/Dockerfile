FROM node:20-bookworm-slim

# ffmpeg (the actual render engine) + fonts. fonts-liberation covers the Latin style presets
# (Arial/Helvetica/etc substitutes). fonts-noto-core adds Malayalam/Tamil/Telugu/Kannada/
# Devanagari(Hindi)/Bengali/Gujarati/Gurmukhi/Oriya/Arabic/Hebrew coverage — this app already
# targets Indic languages elsewhere (see wrangler.toml's SARVAM_API_KEY comment, "Indic languages
# incl. Malayalam/Hindi/Tamil"), and a Malayalam transcript needs a Malayalam-capable font
# installed SOMEWHERE on the system to render at all, regardless of what font name a caption
# style requests — libass's automatic per-glyph font-fallback (verified during development, see
# README.md's dev notes) picks up whichever installed font actually has the needed glyphs, even
# when the requested style font (e.g. "Montserrat" in the Bold Pop preset) has no Malayalam
# coverage itself. Without this package, Malayalam/Tamil/etc. captions would render as tofu boxes
# no matter what font a style names.
#
# The second apt-get block below (libnss3 etc.) is the headless-Chromium runtime dependency set
# Remotion's own docs list for Debian-based images — needed because the Video Templates library's
# animated (Remotion) compositions are rendered by driving real headless Chrome, unlike everything
# else in this service which is pure ffmpeg. Not needed if the Remotion engine is never removed
# from templateRender's engine options, but it is, so it stays.
#
# espeak-ng — free, fully local text-to-speech for AI voiceover/dubbing (lib/tts.js). Genuinely
# free (no API key, offline), at the cost of a clearly robotic voice compared to a paid neural TTS
# API — documented tradeoff, not a placeholder for a "real" TTS to swap in later.
#
# python3/python3-pip — for opt-in self-hosted transcription (asr/transcribe.py, gated behind
# WHISPER_LOCAL_ENABLED — see lib/whisperTranscribe.js). Uses faster-whisper (CTranslate2), NOT
# the literal "whisperX" package that was originally requested — whisperX's own dependency chain
# (pyannote.audio, for speaker diarization, unused here) failed to install cleanly in testing;
# faster-whisper alone (confirmed installing cleanly) already provides the real word-level timing
# this was for, uniformly across every language, without that broken dependency. Real, measured
# footprint of the installed packages: ~150-200MB (ctranslate2+onnxruntime+av — no PyTorch needed,
# unlike whisperX), well short of a multi-GB PyTorch stack.
# AI4Bharat's IndicConformer (asr/transcribe_ai4bharat.py, gated behind AI4BHARAT_ENABLED — see
# lib/ai4bharatTranscribe.js) needs transformers+torch+torchaudio — genuinely heavier than
# faster-whisper above (no way around it: this model is a real PyTorch model, not a CTranslate2
# one). `--index-url .../whl/cpu` is load-bearing, not decorative — without it, pip resolves
# PyPI's default `torch` package, which bundles the full CUDA toolkit (confirmed in testing: this
# alone pulled in 5GB+ of nvidia-* packages that a CPU-only host would never use). The CPU-only
# wheel is a measured ~1.1GB for torch alone, ~1.2GB combined with transformers+torchaudio — still
# meaningfully heavier than faster-whisper's ~150-200MB, but far short of the 5GB+ CUDA-default
# install, and nowhere near whisperX's install-breaking dependency chain that this whole
# self-hosted-transcription effort started by trying (and failing) to use.
#
# soundfile + parler-tts (git install — not published to PyPI under a stable package name, this is
# the project's own documented install method) — AI4Bharat's Indic Parler-TTS
# (tts/synthesize_ai4bharat.py, gated behind AI4BHARAT_TTS_ENABLED — see lib/ai4bharatTts.js). This
# is a STANDBY text-to-speech provider for the WhatsApp voice-to-voice reply feature; Sarvam AI
# stays the PRIMARY provider (called directly from the Worker, unaffected by this). Reuses the same
# torch/transformers already installed above for the ASR model — no additional heavy dependency,
# just this one extra package plus soundfile for WAV writing.
#
# git — needed by `pip install git+https://...` for parler-tts below (confirmed by a real build
# failure: "Cannot find command 'git'" — this base image has no git binary at all). Nothing else
# in this Dockerfile needed git before parler-tts; every other pip package here comes from PyPI/a
# wheel URL, no VCS installs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-liberation fonts-noto-core ca-certificates curl git espeak-ng python3 python3-pip \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libnspr4 \
    libx11-6 libxcb1 libxext6 libxi6 \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir --break-system-packages faster-whisper \
  && pip3 install --no-cache-dir --break-system-packages --index-url https://download.pytorch.org/whl/cpu torch torchaudio \
  && pip3 install --no-cache-dir --break-system-packages transformers \
  && pip3 install --no-cache-dir --break-system-packages soundfile git+https://github.com/huggingface/parler-tts.git

# Pre-downloads both transcription models AT BUILD TIME instead of lazily on the first real
# request — a real production failure (not hypothetical): the first live transcription with either
# feature enabled hit a network-dependent cold-start download that took longer than Coolify's
# reverse-proxy timeout, surfacing as a bare `HTTP 502` with no useful error to act on. Baking the
# weights into the image avoids that class of failure entirely (same reasoning as the RVM/Remotion
# build-time downloads below) at the cost of a larger, slower build — worth it once this has
# actually broken in production once already. `WHISPER_MODEL_SIZE` build arg defaults to the same
# 'small' the runtime code defaults to (lib/whisperTranscribe.js) so the cached model always
# matches what's actually requested unless both are overridden together. If WHISPER_MODEL_SIZE is
# changed at RUNTIME (Coolify env var) to something other than what this image was built with, that
# different size still isn't cached — pass --build-arg WHISPER_MODEL_SIZE=<size> to match, or
# accept one more lazy (and possibly timeout-prone) download for that new size.
ARG WHISPER_MODEL_SIZE=small
ENV WHISPER_MODEL_SIZE=${WHISPER_MODEL_SIZE}
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL_SIZE}', device='cpu', compute_type='int8'); print('faster-whisper model cached')"

# ai4bharat/indic-conformer-600m-multilingual is a GATED Hugging Face repo — confirmed by a real
# build failure (401 GatedRepoError), not documented anywhere findable beforehand. Downloading it
# needs an HF account that has clicked "Agree and access repository" on the model's page
# (https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual) plus a read-scoped access
# token passed in as the HF_TOKEN build arg (Coolify: add HF_TOKEN as a build-time env var/secret
# on this resource). Conditional, not a hard build requirement — AI4BHARAT_ENABLED is opt-in, so a
# missing HF_TOKEN skips this step (with a clear message) instead of failing the ENTIRE build for
# anyone who never intended to use this feature. Without HF_TOKEN, AI4BHARAT_ENABLED will still
# fail at runtime with the same GatedRepoError if someone flips it on — a real, actionable error
# message, not a repeat of the opaque 502 that pre-downloading was meant to avoid in the first
# place, so set HF_TOKEN whenever AI4BHARAT_ENABLED is set.
ARG HF_TOKEN
ENV HF_TOKEN=${HF_TOKEN}
RUN if [ -n "$HF_TOKEN" ]; then \
      python3 -c "from transformers import AutoModel; AutoModel.from_pretrained('ai4bharat/indic-conformer-600m-multilingual', trust_remote_code=True); print('AI4Bharat model cached')"; \
    else \
      echo "HF_TOKEN not set — skipping AI4Bharat model pre-download (AI4BHARAT_ENABLED will fail at runtime with a real GatedRepoError until HF_TOKEN is set and this is rebuilt)."; \
    fi

# ai4bharat/indic-parler-tts — the STANDBY TTS model (AI4BHARAT_TTS_ENABLED, see
# lib/ai4bharatTts.js). Unlike indic-conformer above, this repo's gating status was NOT confirmed
# (no network access to huggingface.co in the dev sandbox this was built in) — attempted
# unconditionally with HF_TOKEN when set (harmless if the repo turns out to be ungated; a token
# doesn't hurt a public repo download), same graceful-skip-with-a-clear-message behavior as above
# if HF_TOKEN isn't set, rather than failing the whole build over a feature that's opt-in anyway.
RUN if [ -n "$HF_TOKEN" ]; then \
      python3 -c "from parler_tts import ParlerTTSForConditionalGeneration; from transformers import AutoTokenizer; m=ParlerTTSForConditionalGeneration.from_pretrained('ai4bharat/indic-parler-tts'); AutoTokenizer.from_pretrained('ai4bharat/indic-parler-tts'); AutoTokenizer.from_pretrained(m.config.text_encoder._name_or_path); print('AI4Bharat TTS model cached')"; \
    else \
      echo "HF_TOKEN not set — skipping AI4Bharat TTS model pre-download (AI4BHARAT_TTS_ENABLED will hit a slow cold-start download, and fail outright if the repo turns out to be gated, until HF_TOKEN is set and this is rebuilt)."; \
    fi

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Downloads Chrome Headless Shell once at build time (instead of on the first Remotion render in
# production, which would otherwise add a slow, network-dependent cold start and re-download on
# every container restart since nothing outside /app/assets and /app/public is persisted).
# `npx remotion browser ensure` (the CLI form) doesn't work here — the CLI binary lives in the
# separate `@remotion/cli` package, which isn't a dependency of this service (only the
# programmatic `remotion`/`@remotion/bundler`/`@remotion/renderer` packages are) — so it's called
# directly via the same `ensureBrowser()` function the CLI itself calls. Not runnable in this
# sandbox (no Docker daemon here — see render-pipeline/README.md's dev notes for what actually was
# verified locally: a real bundle→render using the sandbox's pre-installed Playwright Chromium
# instead).
RUN node -e "require('@remotion/renderer').ensureBrowser().then(() => console.log('Chrome Headless Shell ready')).catch((err) => { console.error(err); process.exit(1); })"

# RobustVideoMatting ONNX model (MIT-licensed, ~15 MB) for the "text behind subject" caption
# style — lib/segmentation.js. Downloaded at build time rather than committed to git (keeps the
# repo free of large binaries); if this URL ever goes stale, any RVM v1.0.0 mobilenetv3 fp32 ONNX
# export works — see lib/segmentation.js's MODEL_PATH.
RUN mkdir -p models && curl -fL -o models/rvm_mobilenetv3_fp32.onnx \
  "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx"

# Bring your own royalty-free B-roll/SFX/music — see assets/*/README.md. Mounting a volume here
# in production means new assets don't need a rebuild+redeploy to pick up (Coolify: add a
# persistent volume at /app/assets). Same for /app/fonts — see fonts/README.md — drop in a real
# Malayalam (or any other) .ttf/.otf and it's usable on the very next render, no rebuild needed
# (ffmpeg's `fontsdir` subtitles-filter option reads it straight off disk).
VOLUME ["/app/assets", "/app/public", "/app/fonts"]

ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]
