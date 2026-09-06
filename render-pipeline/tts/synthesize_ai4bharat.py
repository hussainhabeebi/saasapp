#!/usr/bin/env python3
"""Persistent AI4Bharat Indic Parler-TTS worker.

The model and tokenizers are loaded once, then newline-delimited JSON requests are accepted on
stdin. A JSON response with the same request id is written to stdout. Keeping this process alive
removes the former per-message model cold start.
"""

import json
import sys

import soundfile as sf
import torch
from parler_tts import ParlerTTSForConditionalGeneration
from transformers import AutoTokenizer


LANG_NAMES = {
    'hi': 'Hindi', 'bn': 'Bengali', 'kn': 'Kannada', 'ml': 'Malayalam', 'mr': 'Marathi',
    'or': 'Odia', 'pa': 'Punjabi', 'ta': 'Tamil', 'te': 'Telugu', 'gu': 'Gujarati', 'en': 'English',
}


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main():
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    model = ParlerTTSForConditionalGeneration.from_pretrained('ai4bharat/indic-parler-tts').to(device)
    model.eval()
    tokenizer = AutoTokenizer.from_pretrained('ai4bharat/indic-parler-tts')
    description_tokenizer = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)
    emit({'ready': True, 'device': device, 'sampling_rate': model.config.sampling_rate})

    for raw_line in sys.stdin:
        request_id = None
        try:
            request = json.loads(raw_line)
            request_id = request.get('id')
            text = str(request.get('text') or '').strip()[:500]
            language = str(request.get('language') or '').lower()
            output_path = str(request.get('output_path') or '')
            if not request_id or not text or not output_path:
                raise ValueError('id, text and output_path are required')

            language_name = LANG_NAMES.get(language, 'Indian')
            description = (
                f'A clear, natural-sounding female voice speaks {language_name} at a moderate '
                'pace in a calm, quiet environment.'
            )
            description_ids = description_tokenizer(description, return_tensors='pt').input_ids.to(device)
            prompt_ids = tokenizer(text, return_tensors='pt').input_ids.to(device)
            with torch.inference_mode():
                generation = model.generate(input_ids=description_ids, prompt_input_ids=prompt_ids)
            sf.write(output_path, generation.cpu().numpy().squeeze(), model.config.sampling_rate)
            emit({'id': request_id, 'ok': True, 'sampling_rate': model.config.sampling_rate})
        except Exception as exc:
            emit({'id': request_id, 'ok': False, 'error': str(exc)})


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        emit({'ready': False, 'error': str(exc)})
        sys.exit(1)
