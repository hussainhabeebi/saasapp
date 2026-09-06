FROM node:20-bookworm-slim

# Voice-only runtime: ffmpeg converts generated PCM/WAV into WhatsApp-compatible Ogg/Opus.
# CPU-only PyTorch avoids downloading several gigabytes of unused CUDA libraries on the VPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl git python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir --break-system-packages --index-url https://download.pytorch.org/whl/cpu torch \
  && pip3 install --no-cache-dir --break-system-packages transformers soundfile git+https://github.com/huggingface/parler-tts.git

# Download AI4Bharat TTS during the image build so the first customer request never triggers a
# network cold start. Configure HF_TOKEN as a Coolify build variable when access requires it.
ARG HF_TOKEN
ENV HF_TOKEN=${HF_TOKEN}
RUN python3 -c "from parler_tts import ParlerTTSForConditionalGeneration; from transformers import AutoTokenizer; m=ParlerTTSForConditionalGeneration.from_pretrained('ai4bharat/indic-parler-tts'); AutoTokenizer.from_pretrained('ai4bharat/indic-parler-tts'); AutoTokenizer.from_pretrained(m.config.text_encoder._name_or_path); print('AI4Bharat TTS cached')"

# Keep the small local Piper fallback used by the existing voice integration.
ARG PIPER_VERSION=2023.11.14-2
RUN mkdir -p /opt/piper /app/models/piper-voices \
  && curl -fL -o /tmp/piper.tar.gz "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
  && tar -xzf /tmp/piper.tar.gz -C /opt/piper --strip-components=1 \
  && rm /tmp/piper.tar.gz \
  && curl -fL -o /app/models/piper-voices/en_US-lessac-medium.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx" \
  && curl -fL -o /app/models/piper-voices/en_US-lessac-medium.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .

VOLUME ["/app/models/piper-voices"]
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
