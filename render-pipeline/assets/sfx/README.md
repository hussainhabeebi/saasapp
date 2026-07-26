# Sound effects

Drop your own royalty-free/licensed short sound effects here, named after the cue `tag` they
should match (see `MARKETING_CUE_KEYWORDS` in `cloudflare-worker/worker.js`):

```
assets/sfx/sparkle.mp3
assets/sfx/alert.mp3
assets/sfx/impact.mp3
assets/sfx/whoosh.mp3
assets/sfx/click.mp3
```

Accepted extensions: `.mp3`, `.wav`, `.m4a`. Keep these short (under ~1s) — they're mixed in as a
one-shot at the cue's timestamp, not looped.

If a tag has no matching file, that cue is simply skipped (logged, not fatal). No audio ships in
this repo; there's no license to redistribute sound libraries.
