FROM node:20-bookworm-slim

# ffmpeg (the actual render engine) + fontconfig/liberation fonts (so caption burn-in has a real
# font to substitute Arial/Helvetica/etc against — see lib/subtitles.js's fontName handling;
# ffmpeg's `subtitles` filter resolves fonts via fontconfig, same as verified against this exact
# combination during development, see README.md's dev notes).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Bring your own royalty-free B-roll/SFX/music — see assets/*/README.md. Mounting a volume here
# in production means new assets don't need a rebuild+redeploy to pick up (Coolify: add a
# persistent volume at /app/assets).
VOLUME ["/app/assets", "/app/public"]

ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]
