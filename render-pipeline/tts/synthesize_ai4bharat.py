#!/usr/bin/env python3
# Self-hosted text-to-speech STANDBY via AI4Bharat's Indic Parler-TTS
# (ai4bharat/indic-parler-tts on Hugging Face) — the TTS counterpart to
# asr/transcribe_ai4bharat.py's self-hosted speech-to-text. Added specifically for the WhatsApp
# voice-to-voice reply feature (cloudflare-worker/worker.js's engineSarvamTts / engineDeliverReply):
# Sarvam AI stays the PRIMARY TTS provider everywhere, unchanged — this only runs as a standby when
# Sarvam's call already failed or SARVAM_API_KEY isn't configured, so a customer still gets a real
# voice-note reply instead of silently downgrading straight to text (see lib/ai4bharatTts.js and
# worker.js's engineTtsWithFallback).
#
# IMPORTANT — honest scope, same "verified vs not" convention as transcribe_ai4bharat.py: this
# model's documented usage pattern (ParlerTTSForConditionalGeneration.from_pretrained + a separate
# text-encoder tokenizer for the "description" prompt + a prompt tokenizer for the spoken text
# itself) is confirmed from the model's own card / the parler-tts project's documented usage, NOT
# from a live call — no network access to huggingface.co and no machine large enough to load this
# model were available in the dev sandbox this was built in. Two things specifically are
# unverified and may need correction after a real deploy:
#   1. The exact per-language "description" phrasing the model card recommends for best voice/
#      language fidelity (some Parler-TTS-family models document specific named speakers per
#      language for best results). A generic English description naming the target language is
#      used here instead of a named-speaker prompt, since specific recommended speaker names per
#      language couldn't be confirmed without live docs access. If real output comes back in the
#      wrong language or an unexpected voice, this description string is the first thing to check
#      against the model's actual card.
#   2. Real inference latency on CPU (no GPU configured here, same as the rest of this service) —
#      expect this to be materially slower than Sarvam's API call, likely several seconds to tens
#      of seconds depending on text length and host. This is a "customer still gets a voice note"
#      standby, not a low-latency guarantee.
#
# Scope is deliberately narrow: only the languages this app already has an AI4Bharat mapping for
# elsewhere (AI4BHARAT_LANGS in lib/ai4bharatTranscribe.js) are wired up as a standby here — not
# the full ~21 languages Indic Parler-TTS itself covers, since nothing else in this app has a
# reason to route to those yet.
import sys
import json

LANG_NAMES = {
    'hi': 'Hindi', 'bn': 'Bengali', 'kn': 'Kannada', 'ml': 'Malayalam', 'mr': 'Marathi',
    'or': 'Odia', 'pa': 'Punjabi', 'ta': 'Tamil', 'te': 'Telugu', 'gu': 'Gujarati', 'en': 'English',
}


def main():
    if len(sys.argv) < 4:
        print(json.dumps({'error': 'usage: synthesize_ai4bharat.py <text> <language_code> <output_wav_path>'}), file=sys.stderr)
        sys.exit(1)

    text = sys.argv[1]
    language = sys.argv[2]
    output_path = sys.argv[3]

    import torch
    from parler_tts import ParlerTTSForConditionalGeneration
    from transformers import AutoTokenizer
    import soundfile as sf

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    model = ParlerTTSForConditionalGeneration.from_pretrained('ai4bharat/indic-parler-tts').to(device)
    tokenizer = AutoTokenizer.from_pretrained('ai4bharat/indic-parler-tts')
    description_tokenizer = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)

    lang_name = LANG_NAMES.get(language, 'Indian')
    # Generic, not a named-speaker prompt — see module header comment for why. Explicitly asks for
    # a clear, natural, moderate-pace female voice, matching Sarvam's own default voice choice
    # (ENGINE_TTS_SPEAKER='anushka' in worker.js) so a customer doesn't notice a jarring voice
    # switch between primary and standby.
    description = f"A clear, natural-sounding female voice speaks {lang_name} at a moderate pace in a calm, quiet environment."

    description_ids = description_tokenizer(description, return_tensors='pt').input_ids.to(device)
    prompt_ids = tokenizer(text, return_tensors='pt').input_ids.to(device)

    generation = model.generate(input_ids=description_ids, prompt_input_ids=prompt_ids)
    audio_arr = generation.cpu().numpy().squeeze()
    sf.write(output_path, audio_arr, model.config.sampling_rate)

    print(json.dumps({'ok': True, 'sampling_rate': model.config.sampling_rate}))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)
