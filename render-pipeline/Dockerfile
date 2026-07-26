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
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-liberation fonts-noto-core ca-certificates \
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
