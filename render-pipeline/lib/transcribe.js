// Calls OpenAI's Whisper endpoint from THIS server rather than from the Worker. Real fix for a
// real bug: OpenAI's API blocks requests whose source IP resolves to certain countries/regions —
// Cloudflare Workers run on a globally distributed edge network with unpredictable egress IPs per
// request, so calling OpenAI directly from worker.js hit "Country, region, or territory not
// supported" even though the account/user's actual location is fine. This server runs on one
// fixed host (whatever Coolify/VPS location it's deployed to), so its outbound IP is stable and
// (assuming that location is one OpenAI serves) doesn't hit that block. Reuses extractAudio() for
// the same reason /extract-audio does — sending audio-only keeps well under Whisper's 25 MB cap.
//
// When a project is explicitly tagged with an Indic language Sarvam supports (see
// sarvamTranscribe.js) and SARVAM_API_KEY is configured, that takes priority over Whisper —
// Whisper's real-world Malayalam accuracy turned out to be weak (a production project came back
// mislabeled/garbled), while Sarvam is purpose-built for Indian languages. No language hint at
// all still goes to Whisper, since there's nothing to route on ahead of time.
//
// WHISPER_LOCAL_ENABLED (opt-in, off by default — see lib/whisperTranscribe.js) takes top
// priority when set: self-hosted, so no per-request API cost, no OpenAI country-block risk, and —
// the reason it was added — a well-documented, verified response shape instead of Sarvam's
// undocumented one, which became a real repeated source of production bugs (captions landing in
// empty/wrong scenes). Genuinely heavier to run than either API-based path (a real Python ML
// stack in this container), which is why it's opt-in rather than a silent default swap.
//
// AI4BHARAT_ENABLED (also opt-in — see lib/ai4bharatTranscribe.js) sits between local Whisper and
// Sarvam: REPLACES Sarvam specifically for the Indic languages it covers, since it targets the
// exact same problem (better Indic-language accuracy than generic Whisper) without Sarvam's
// chunking/offset arithmetic — a single-pass call per video, no 30s-per-request cap to work
// around, which removes the whole class of chunk-boundary bug Sarvam's integration had. Honest
// tradeoff: no word-level timestamps from this model's documented interface (only faster-whisper,
// above, has those) — word timing falls back to the same evenly-split-across-duration
// approximation used elsewhere in this app, flagged approximate:true.
const { extractAudio } = require('./extractAudio');
const { transcribeWithSarvam, supportsLanguage: sarvamSupportsLanguage } = require('./sarvamTranscribe');
const { transcribeWithWhisperLocal } = require('./whisperTranscribe');
const { transcribeWithAi4Bharat, supportsLanguage: ai4bharatSupportsLanguage } = require('./ai4bharatTranscribe');

async function callWhisper(apiKey, apiUrl, audioBuffer, language) {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  if (language) form.append('language', language); // omit to let the API auto-detect

  const r = await fetch(apiUrl, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error?.message || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

async function transcribe(sourceUrl, language, env) {
  if (env.WHISPER_LOCAL_ENABLED) {
    return await transcribeWithWhisperLocal(sourceUrl, language, env);
  }
  if (env.AI4BHARAT_ENABLED && ai4bharatSupportsLanguage(language)) {
    return await transcribeWithAi4Bharat(sourceUrl, language, env);
  }
  if (env.SARVAM_API_KEY && sarvamSupportsLanguage(language)) {
    return await transcribeWithSarvam(sourceUrl, language, env);
  }

  const apiKey = env.MARKETING_TRANSCRIBE_API_KEY;
  if (!apiKey) throw new Error('MARKETING_TRANSCRIBE_API_KEY is not set on the render pipeline.');
  const apiUrl = env.MARKETING_TRANSCRIBE_API_URL || 'https://api.openai.com/v1/audio/transcriptions';

  const audioBuffer = await extractAudio(sourceUrl);
  try {
    return await callWhisper(apiKey, apiUrl, audioBuffer, language);
  } catch (err) {
    // A language hint a project can be tagged with (e.g. Malayalam, "ml") isn't necessarily in
    // OpenAI's Whisper API's accepted `language` parameter list — confirmed via a real
    // "Language 'ml' is not supported." response — even though the underlying model can often
    // still transcribe that audio correctly through auto-detection; the parameter is only a
    // decoding hint, not a hard requirement. Retry once without it instead of failing the whole
    // transcription over a hint OpenAI won't accept.
    if (language && /language .* is not supported/i.test(err.message || '')) {
      return await callWhisper(apiKey, apiUrl, audioBuffer, null);
    }
    throw err;
  }
}

module.exports = { transcribe };
