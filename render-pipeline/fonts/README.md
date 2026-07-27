# Custom caption fonts

Drop `.ttf`/`.otf` font files here to use them for burned-in captions — useful for a real,
good-looking Malayalam (or any other) typeface instead of relying on whatever generic font
`fonts-noto-core`'s automatic glyph-fallback happens to substitute in.

```
render-pipeline/fonts/Manjari-Bold.ttf
render-pipeline/fonts/Meera.ttf
```

## How to use one

1. Drop the font file in here (mount this as a persistent Coolify volume, same as `assets/`, so it
   survives a redeploy without a rebuild).
2. Find the font's own internal **family name** — NOT the filename. Most font files declare their
   family name inside the file itself (e.g. a font file named `Manjari-Bold.ttf` might declare its
   family name as just `Manjari` with a separate Bold weight, not `Manjari-Bold`). If you're not
   sure, `fc-scan <file>` on any machine with `fontconfig` installed prints it (look for the
   `family:` line), or open the file in a font-preview app.
3. Set that exact family name as a caption style's `font` — either directly in a custom
   `MARKETING_STYLE_PRESETS`/brand style entry in `worker.js`, or via a brand style's font field in
   the Marketing Studio UI (Editor → Caption style → Save current look as a brand style, then edit
   the font name).

No fontconfig/`fc-cache` registration needed — ffmpeg's `subtitles` filter is pointed at this
directory directly via its own `fontsdir` option (`lib/filtergraph.js`), which libass reads
straight off disk at render time. A font dropped in here is available on the very next render, no
container restart required.

## Suggested free/open-license Malayalam fonts (not bundled — add the file yourself)

- **Manjari** (SIL OFL) — used by the Kerala government, clean and modern.
- **Meera** (SMC, GPL) — a long-standing, well-tested Malayalam typeface.
- **Baloo Chettan 2** (Google Fonts, SIL OFL) — a bold, rounded display face, good for
  short-form-video-style captions specifically.

None of these are redistributed in this repo (keep the repo free of font-licensing questions) —
download whichever you want from its own source and drop the file in here.
