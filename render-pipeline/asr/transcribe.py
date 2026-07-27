#!/usr/bin/env python3
# Self-hosted transcription via faster-whisper (CTranslate2-backed Whisper). See
# render-pipeline/lib/whisperTranscribe.js for why this exists and how it was chosen over the
# literal "whisperX" package that was originally requested — short version: whisperX's own
# dependency chain (pyannote.audio, pulled in for speaker diarization, a feature not used here)
# failed to install in testing, and its actual differentiator (per-language wav2vec2 forced
# alignment) doesn't clearly cover Tamil/Malayalam anyway. faster-whisper's own `word_timestamps`
# (DTW over cross-attention weights, not a separate per-language model) gives real word-level
# timing uniformly across every language Whisper supports, which is the actual thing this was for.
#
# Verified: `pip install faster-whisper` succeeds cleanly (confirmed in a real Python 3.11 env —
# unlike the full `whisperx` package, which does not, see above), and every field name used below
# (Segment.start/end/text/words, Word.word/start/end) was confirmed via direct
# `dataclasses.fields()` inspection of the installed package, not assumed from memory. NOT
# verified: actual model download + inference end-to-end — this dev sandbox's outbound proxy
# returns 403 for huggingface.co, so a real transcription could not be run here. Test against a
# real audio file after deploying.
import sys
import json


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'usage: transcribe.py <audio_path> [language] [model_size]'}), file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] not in ('', 'auto', 'null') else None
    model_size = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else 'small'

    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device='cpu', compute_type='int8')
    # vad_filter=True skips silent stretches instead of feeding them to the model — real, published
    # faster-whisper guidance for reducing hallucinated text on quiet audio, not a guess.
    segments, info = model.transcribe(audio_path, language=language, word_timestamps=True, vad_filter=True)

    words = []
    text_parts = []
    for seg in segments:
        seg_text = (seg.text or '').strip()
        if seg_text:
            text_parts.append(seg_text)
        if seg.words:
            for w in seg.words:
                token = (w.word or '').strip()
                if token:
                    words.append({'word': token, 'start': w.start, 'end': w.end})
        elif seg_text:
            # word_timestamps=True should always populate seg.words — this is a defensive
            # fallback (evenly split the segment's text across its own duration) for the
            # unexpected case it doesn't, same convention as this app's other transcription paths
            # (marketingWordsFromTranscription's segments-only fallback, sarvamTranscribe.js's
            # evenly-split fallback) rather than silently dropping that segment's words.
            tokens = seg_text.split()
            span = (seg.end - seg.start) / len(tokens)
            for i, t in enumerate(tokens):
                words.append({'word': t, 'start': seg.start + i * span, 'end': seg.start + (i + 1) * span, 'approximate': True})

    print(json.dumps({'language': info.language, 'text': ' '.join(text_parts), 'words': words}))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)
