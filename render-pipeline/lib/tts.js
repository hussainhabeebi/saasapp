// Free, fully local text-to-speech via espeak-ng (apt-installable, GPL-licensed synthesizer
// binary, no API key, no per-request cost, works fully offline) — for generating an AI
// voiceover/dub track. Genuinely free, unlike a neural TTS API (ElevenLabs etc): the tradeoff is
// voice quality — espeak-ng is a formant/rule-based synthesizer and sounds clearly
// robotic/mechanical, not a studio-quality AI voice. That tradeoff is documented upfront here and
// in SETUP.md, not discovered after shipping.
const fs = require('fs');
const { run } = require('./exec');

// A handful of espeak-ng's built-in voices, mapped from this app's own language codes (the same
// ones already used for transcription — see render-pipeline/lib/transcribe.js /
// sarvamTranscribe.js). Falls back to English for any language with no espeak-ng voice at all —
// producing SOMETHING rather than failing outright, since a v1 voiceover in the wrong accent is
// still more useful than no voiceover.
const VOICE_MAP = {
  en: 'en-us', hi: 'hi', ta: 'ta', te: 'te', kn: 'kn', bn: 'bn', mr: 'mr', gu: 'gu',
  es: 'es', fr: 'fr', de: 'de', pt: 'pt', ar: 'ar', ru: 'ru', ja: 'ja', zh: 'cmn',
  // espeak-ng has no dedicated Malayalam voice — en-us is the closest available fallback, not a
  // real Malayalam voice; flagged rather than silently mis-mapped to something that looks correct.
  ml: 'en-us',
};

async function synthesizeVoiceover(text, language, outputPath) {
  if (!text || !text.trim()) throw new Error('No text to synthesize.');
  const voice = VOICE_MAP[language] || 'en-us';
  const isWav = outputPath.toLowerCase().endsWith('.wav');
  const wavPath = isWav ? outputPath : outputPath + '.tmp.wav';
  // -s 165: words-per-minute close to natural narration pace (espeak-ng's own default is 175 —
  // slightly faster than typical narration; slowed down a little for clarity, not tuned further).
  await run('espeak-ng', ['-v', voice, '-s', '165', '-w', wavPath, text]);
  if (!isWav) {
    await run('ffmpeg', ['-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-qscale:a', '4', outputPath]);
    fs.unlinkSync(wavPath);
  }
  return outputPath;
}

module.exports = { synthesizeVoiceover, VOICE_MAP };
