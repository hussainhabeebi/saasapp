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
# unlike whisperX), well short of a multi-GB PyTorch stack; the Whisper model itself (small,
# int8-quantized) adds roughly another few hundred MB, downloaded lazily on first use rather than
# baked into the image (network-dependent cold start on first real transcription, same tradeoff as
# leaving RVM/Remotion's models to a build-time curl would avoid — a deliberate choice to keep the
# image build itself fast and not fail if that download flakes).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-liberation fonts-noto-core ca-certificates curl espeak-ng python3 python3-pip \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libnspr4 \
    libx11-6 libxcb1 libxext6 libxi6 \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir --break-system-packages faster-whisper

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
