# Background music

Drop your own royalty-free/licensed music beds here, named after the option value the Marketing
Studio UI offers (`frontend/marketing-studio.html`'s `#optMusic` select):

```
assets/music/upbeat.mp3
assets/music/chill.mp3
assets/music/cinematic.mp3
```

Accepted extensions: `.mp3`, `.wav`, `.m4a`, `.ogg`. Any length works — it's looped and trimmed to
the output's duration automatically.

If the selected option has no matching file, background music is silently skipped (logged, not
fatal) — the render still completes without it. No music ships in this repo; there's no license
to redistribute a music library.

**Known limitation:** mixing is a constant-level duck (music played quietly under the speech
track throughout), not true sidechain compression that dips the music only while someone's
talking. Real ducking (`sidechaincompress`) is a reasonable upgrade — see `lib/filtergraph.js`.
