# B-roll clips

Drop your own royalty-free/licensed video clips here, named after the cue `tag` they should match
(see `MARKETING_CUE_KEYWORDS` in `cloudflare-worker/worker.js` for the full list):

```
assets/broll/money.mp4
assets/broll/speed.mp4
assets/broll/office.mp4
assets/broll/phone.mp4
assets/broll/location.mp4
assets/broll/product.mp4
assets/broll/people.mp4
```

Accepted extensions: `.mp4`, `.mov`, `.webm`, `.m4v`.

If a tag has no matching file, that cue is simply skipped (logged, not fatal) — nothing breaks,
that one B-roll insert just doesn't happen. No footage ships in this repo; there's no license to
redistribute stock video.

B-roll is composited as a corner picture-in-picture insert during the cue's time window, not a
full-screen cutaway — see `SETUP.md` and `lib/filtergraph.js` for why.
