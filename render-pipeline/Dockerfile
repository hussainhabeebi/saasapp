FROM node:20-bookworm-slim

# Keep the normal Coolify image small and reliable. Piper is the primary local voice engine;
# AI4Bharat's multi-GB PyTorch stack is opt-in for a separate, sufficiently large host.
ARG INSTALL_AI4BHARAT_TTS=false
ENV AI4BHARAT_TTS_INSTALLED=${INSTALL_AI4BHARAT_TTS}

# Voice-only runtime: ffmpeg converts generated PCM/WAV into WhatsApp-compatible Ogg/Opus.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# CPU-only PyTorch + transformers for lightweight VITS models (~50 MB each, vs ~4 GB Parler-TTS).
RUN if [ "${INSTALL_AI4BHARAT_TTS}" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends python3 python3-pip \
      && rm -rf /var/lib/apt/lists/* \
      && pip3 install --no-cache-dir --break-system-packages --index-url https://download.pytorch.org/whl/cpu torch \
      && pip3 install --no-cache-dir --break-system-packages soundfile transformers accelerate; \
    else \
      echo "Skipping optional AI4Bharat/PyTorch layer"; \
    fi

# Pre-cache the six most common Indic language VITS models so the first request per language is
# instant. Other languages load lazily on first use. No HF_TOKEN needed — these are public models.
ARG HF_TOKEN
ENV HF_TOKEN=${HF_TOKEN}
RUN if [ "${INSTALL_AI4BHARAT_TTS}" = "true" ]; then \
      python3 -c "\
from transformers import VitsModel, AutoTokenizer; \
models = ['facebook/mms-tts-hin','facebook/mms-tts-mal','facebook/mms-tts-tam', \
          'facebook/mms-tts-tel','facebook/mms-tts-ben','facebook/mms-tts-eng']; \
[VitsModel.from_pretrained(m) and AutoTokenizer.from_pretrained(m) for m in models]; \
print('VITS models cached')"; \
    fi

# Keep the small local Piper tier used before AI4Bharat. English, Malayalam and Hindi are baked
# into the image so a fresh Coolify deployment is ready without manually populating its volume.
ARG PIPER_VERSION=2023.11.14-2
RUN mkdir -p /opt/piper /app/models/piper-voices \
  && curl -fL -o /tmp/piper.tar.gz "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
  && tar -xzf /tmp/piper.tar.gz -C /opt/piper --strip-components=1 \
  && rm /tmp/piper.tar.gz \
  && curl -fL -o /app/models/piper-voices/en_US-lessac-medium.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx" \
  && curl -fL -o /app/models/piper-voices/en_US-lessac-medium.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json" \
  && curl -fL -o /app/models/piper-voices/ml_IN-meera-medium.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/main/ml/ml_IN/meera/medium/ml_IN-meera-medium.onnx" \
  && curl -fL -o /app/models/piper-voices/ml_IN-meera-medium.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/ml/ml_IN/meera/medium/ml_IN-meera-medium.onnx.json" \
  && curl -fL -o /app/models/piper-voices/hi_IN-priyamvada-medium.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium.onnx" \
  && curl -fL -o /app/models/piper-voices/hi_IN-priyamvada-medium.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium.onnx.json"

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
