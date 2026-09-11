#!/usr/bin/env python3
"""Persistent Indic VITS-TTS worker using Facebook MMS VITS models.

One Python process stays alive for the container lifetime. Models are loaded lazily per language
on first request and cached in memory. Each language model is ~50 MB (vs ~4 GB for Parler-TTS),
so startup is instant and total RAM stays low even with several languages cached.
"""

import json
import sys

import soundfile as sf
import torch
from transformers import AutoTokenizer, VitsModel

# ISO 639-1 → Facebook MMS VITS model id
LANG_MODELS = {
    'hi': 'facebook/mms-tts-hin',
    'bn': 'facebook/mms-tts-ben',
    'kn': 'facebook/mms-tts-kan',
    'ml': 'facebook/mms-tts-mal',
    'mr': 'facebook/mms-tts-mar',
    'or': 'facebook/mms-tts-ori',
    'pa': 'facebook/mms-tts-pan',
    'ta': 'facebook/mms-tts-tam',
    'te': 'facebook/mms-tts-tel',
    'gu': 'facebook/mms-tts-guj',
    'en': 'facebook/mms-tts-eng',
}

_cache = {}  # lang → (VitsModel, AutoTokenizer)


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def get_model(language):
    lang = language if language in LANG_MODELS else 'hi'
    if lang not in _cache:
        model_id = LANG_MODELS[lang]
        model = VitsModel.from_pretrained(model_id)
        tokenizer = AutoTokenizer.from_pretrained(model_id)
        model.eval()
        _cache[lang] = (model, tokenizer)
    return _cache[lang]


def main():
    # Emit ready immediately — models load lazily on first request per language.
    emit({'ready': True, 'device': 'cpu', 'sampling_rate': 16000})

    for raw_line in sys.stdin:
        request_id = None
        try:
            request = json.loads(raw_line)
            request_id = request.get('id')
            text = str(request.get('text') or '').strip()[:500]
            language = str(request.get('language') or 'hi').lower()
            output_path = str(request.get('output_path') or '')
            if not request_id or not text or not output_path:
                raise ValueError('id, text and output_path are required')

            model, tokenizer = get_model(language)
            inputs = tokenizer(text, return_tensors='pt')
            with torch.no_grad():
                waveform = model(**inputs).waveform.squeeze().numpy()

            sampling_rate = model.config.sampling_rate
            sf.write(output_path, waveform, sampling_rate)
            emit({'id': request_id, 'ok': True, 'sampling_rate': sampling_rate})
        except Exception as exc:
            emit({'id': request_id, 'ok': False, 'error': str(exc)})


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        emit({'ready': False, 'error': str(exc)})
        sys.exit(1)
