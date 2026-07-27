#!/usr/bin/env python3
# Self-hosted transcription via AI4Bharat's IndicConformer (ai4bharat/indic-conformer-600m-
# multilingual on Hugging Face) — a 600M-parameter Conformer ASR model covering all 22 official
# Indian languages (Hindi, Tamil, Malayalam, etc.), MIT-licensed. Requested specifically to
# improve Tamil/Malayalam accuracy over both Sarvam (undocumented response shape, the source of a
# real recurring bug — see lib/sarvamTranscribe.js) and generic Whisper (weak real-world Indic
# accuracy, see lib/transcribe.js's header comment).
#
# IMPORTANT — honest scope: this model's documented interface (`model(wav, lang, "ctc")`) returns
# PLAIN TEXT ONLY, no word-level timestamps. Unlike faster-whisper (lib/whisperTranscribe.js),
# which has its own built-in word_timestamps, no timestamp API for this model could be confirmed
# to exist in its Hugging Face model card or GitHub repo. So: this genuinely improves the
# RECOGNIZED TEXT for Tamil/Malayalam/other Indic languages (a single-pass call, no chunking/
# offset arithmetic — the whole class of bug Sarvam's chunking introduced doesn't exist here), but
# word timing is the SAME evenly-split-across-duration approximation this app already uses as a
# fallback elsewhere (marketingWordsFromTranscription's segments-only path, Sarvam's own
# no-usable-timestamp fallback) — flagged approximate:true, not a false claim of precision.
#
# Verified: the model's documented usage pattern (AutoModel.from_pretrained(...,
# trust_remote_code=True), torchaudio load+resample to 16kHz mono, model(wav, lang, "ctc")) is
# confirmed via the model's own Hugging Face card. NOT verified: actual model download+inference
# (this dev sandbox's proxy blocks huggingface.co) — and real weight was measured for the
# DEPENDENCIES only (torch+transformers+torchaudio, ~1.1GB combined even with the CPU-only torch
# wheel — meaningfully heavier than faster-whisper's ~200MB, though nowhere near as broken/heavy
# as the literal whisperX+NeMo path this replaced). Test against real audio after deploying.
import sys
import json


def main():
    if len(sys.argv) < 3:
        print(json.dumps({'error': 'usage: transcribe_ai4bharat.py <audio_path> <language_code>'}), file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    language = sys.argv[2]

    import torch
    import torchaudio
    from transformers import AutoModel

    model = AutoModel.from_pretrained('ai4bharat/indic-conformer-600m-multilingual', trust_remote_code=True)

    wav, sr = torchaudio.load(audio_path)
    wav = torch.mean(wav, dim=0, keepdim=True)  # collapse to mono — model expects single-channel audio
    target_sr = 16000
    if sr != target_sr:
        wav = torchaudio.transforms.Resample(orig_freq=sr, new_freq=target_sr)(wav)
    duration_sec = wav.shape[-1] / target_sr

    text = model(wav, language, 'ctc')
    if not isinstance(text, str):
        text = str(text)
    text = text.strip()

    tokens = text.split()
    words = []
    if tokens:
        span = duration_sec / len(tokens)
        for i, t in enumerate(tokens):
            words.append({'word': t, 'start': i * span, 'end': (i + 1) * span, 'approximate': True})

    print(json.dumps({'language': language, 'text': text, 'words': words}))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)
