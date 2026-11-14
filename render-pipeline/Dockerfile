FROM node:20-bookworm-slim

# Keep the normal Coolify image small and reliable. Piper (always installed) is the backup voice;
# AI4Bharat Indic Parler-TTS, the primary summary voice, is opt-in for a host with enough RAM.
ARG INSTALL_AI4BHARAT_TTS=false
ENV AI4BHARAT_TTS_INSTALLED=${INSTALL_AI4BHARAT_TTS}

# Voice-only runtime: ffmpeg converts generated PCM/WAV into WhatsApp-compatible Ogg/Opus.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# AI4Bharat Indic Parler-TTS (ai4bharat/indic-parler-tts, Apache-2.0) — primary voice for the
# end-of-session Malayalam/Hindi summary. ~4 GB of weights; needs 6-8 GB RAM. CPU PyTorch by
# default; summaries are delayed, so slower CPU synthesis is acceptable.
RUN if [ "${INSTALL_AI4BHARAT_TTS}" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends python3 python3-pip git \
      && rm -rf /var/lib/apt/lists/* \
      && pip3 install --no-cache-dir --break-system-packages typing_extensions \
      && pip3 install --no-cache-dir --break-system-packages --extra-index-url https://download.pytorch.org/whl/cpu torch \
      && pip3 install --no-cache-dir --break-system-packages soundfile git+https://github.com/huggingface/parler-tts.git; \
    else \
      echo "Skipping optional AI4Bharat/PyTorch layer"; \
    fi

# Pre-download the Parler model and tokenizers at build time so the first summary does not wait
# on a multi-GB download. Pass HF_TOKEN if Hugging Face asks for model access.
ARG HF_TOKEN
ENV HF_TOKEN=${HF_TOKEN}
RUN if [ "${INSTALL_AI4BHARAT_TTS}" = "true" ]; then \
      python3 -c "from parler_tts import ParlerTTSForConditionalGeneration; from transformers import AutoTokenizer; m=ParlerTTSForConditionalGeneration.from_pretrained('ai4bharat/indic-parler-tts'); AutoTokenizer.from_pretrained('ai4bharat/indic-parler-tts'); AutoTokenizer.from_pretrained(m.config.text_encoder._name_or_path); print('Indic Parler-TTS cached')"; \
    fi

# Piper backup voices (used when Parler is unavailable or fails). English, Malayalam and Hindi are baked
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
