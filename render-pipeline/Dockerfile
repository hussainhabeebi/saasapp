FROM node:20-bookworm-slim

# Keep the normal Coolify image small and reliable. Piper is the primary local voice engine;
# AI4Bharat's multi-GB PyTorch stack is opt-in for a separate, sufficiently large host.
ARG INSTALL_AI4BHARAT_TTS=false
ENV AI4BHARAT_TTS_INSTALLED=${INSTALL_AI4BHARAT_TTS}

# Voice-only runtime: ffmpeg converts generated PCM/WAV into WhatsApp-compatible Ogg/Opus.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# CPU-only PyTorch avoids the several-GB CUDA dependency set. Pin Parler-TTS to a known commit so
# a future upstream change cannot unexpectedly break a production image build.
RUN if [ "${INSTALL_AI4BHARAT_TTS}" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends git python3 python3-pip \
      && rm -rf /var/lib/apt/lists/* \
      && pip3 install --no-cache-dir --break-system-packages --index-url https://download.pytorch.org/whl/cpu torch \
      && pip3 install --no-cache-dir --break-system-packages soundfile "git+https://github.com/huggingface/parler-tts.git@d108732cd57788ec86bc857d99a6cabd66663d68"; \
    else \
      echo "Skipping optional AI4Bharat/PyTorch layer"; \
    fi

# Download AI4Bharat TTS during the image build so the first customer request never triggers a
# network cold start. Configure HF_TOKEN as a Coolify build variable when access requires it.
ARG HF_TOKEN
ENV HF_TOKEN=${HF_TOKEN}
RUN if [ "${INSTALL_AI4BHARAT_TTS}" = "true" ]; then \
      python3 -c "from parler_tts import ParlerTTSForConditionalGeneration; from transformers import AutoTokenizer; m=ParlerTTSForConditionalGeneration.from_pretrained('ai4bharat/indic-parler-tts'); AutoTokenizer.from_pretrained('ai4bharat/indic-parler-tts'); AutoTokenizer.from_pretrained(m.config.text_encoder._name_or_path); print('AI4Bharat TTS cached')"; \
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
