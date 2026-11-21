#!/usr/bin/env python3
"""Persistent AI4Bharat Indic Parler-TTS worker (ai4bharat/indic-parler-tts, Apache-2.0).

One Python process stays alive for the container lifetime and owns one loaded model. Requests are
newline-delimited JSON on stdin and are processed strictly one at a time; results go to stdout.

Only Malayalam and Hindi are served. Each language uses one fixed named speaker from the model
card so every summary voice note sounds the same. Override a description with
PARLER_VOICE_ML / PARLER_VOICE_HI.
"""

import json
import os
import sys

import soundfile as sf
import torch
from parler_tts import ParlerTTSForConditionalGeneration
from transformers import AutoTokenizer

MODEL_ID = os.environ.get('PARLER_MODEL_ID', 'ai4bharat/indic-parler-tts')

VOICES = {
    'ml': os.environ.get('PARLER_VOICE_ML') or (
        "Anjali speaks at a moderate pace with a clear, warm and friendly tone. "
        "The recording is of very high quality, with the speaker's voice sounding clear and very close up."
    ),
    'hi': os.environ.get('PARLER_VOICE_HI') or (
        "Divya speaks at a moderate pace with a clear, warm and friendly tone. "
        "The recording is of very high quality, with the speaker's voice sounding clear and very close up."
    ),
}


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def load():
    device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
    model = ParlerTTSForConditionalGeneration.from_pretrained(MODEL_ID).to(device)
    model.eval()
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    description_tokenizer = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)
    return device, model, tokenizer, description_tokenizer


def main():
    device, model, tokenizer, description_tokenizer = load()
    sampling_rate = model.config.sampling_rate
    emit({'ready': True, 'device': device, 'sampling_rate': sampling_rate})

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
            if language not in VOICES:
                raise ValueError(f'Unsupported language: {language}')

            description = description_tokenizer(VOICES[language], return_tensors='pt').to(device)
            prompt = tokenizer(text, return_tensors='pt').to(device)
            with torch.no_grad():
                generation = model.generate(
                    input_ids=description.input_ids,
                    attention_mask=description.attention_mask,
                    prompt_input_ids=prompt.input_ids,
                    prompt_attention_mask=prompt.attention_mask,
                )
            waveform = generation.cpu().numpy().squeeze()
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
