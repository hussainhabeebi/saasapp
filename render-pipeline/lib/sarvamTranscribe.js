// Real transcription for Indic languages via Sarvam AI (docs.sarvam.ai) instead of OpenAI's
// Whisper — Whisper's Malayalam support in particular turned out to be weak in production (a
// real project's audio came back mislabeled/garbled), while Sarvam is purpose-built for Indian
// languages. Normalizes to the exact same {language, text, words:[{word,start,end}]} shape
// worker.js already expects from Whisper's verbose_json (see lib/transcribe.js) — everything
// downstream (marketingWordsFromTranscription, the caption editor) needs zero changes.
//
// Sarvam's word-timestamp REST endpoint caps a single request at 30 seconds of audio, so a real
// video needs chunking first — done here by reusing this app's own silence detection
// (lib/timeline.js, already built for silence-cut) to prefer cutting chunks at quiet moments
// instead of mid-word, then calling Sarvam once per chunk and stitching the results back into one
// timeline by offsetting each chunk's word times by its start offset in the full audio.
//
// IMPORTANT — response parsing is NOT verified against a real Sarvam response. Sarvam's own docs
// site (docs.sarvam.ai) returned HTTP 403 to every fetch attempted while building this (bot
// protection), and no SARVAM_API_KEY / live audio was available in this dev sandbox to test
// against the real API either. The request shape (endpoint, `api-subscription-key` header,
// multipart fields, `with_timestamps`) is high-confidence — the auth header name matches this
// app's existing, working Sarvam TTS integration (engineSarvamTts in worker.js), and the rest is
// corroborated across several independent sources. The exact response JSON field names for
// word-level timestamps are the one genuinely unverified piece, so parseSarvamWords() below
// defensively tries a couple of plausible shapes and falls back to evenly-split timing (flagged
// approximate, same as this app's existing Whisper-segments-only fallback) rather than crashing
// if none match. Test against a real Malayalam project once deployed; if it comes back
// `approximate:true` for every word, Sarvam's actual response shape differs from all of the
// candidates tried here — paste a raw response and the parser can be corrected in one place.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { downloadToFile } = require('./download');
const { run } = require('./exec');
const { getDurationSec } = require('./probe');
const { detectSilence } = require('./timeline');

const MAX_CHUNK_SEC = 25; // under Sarvam's 30s REST cap, with margin

// ISO-639-1 (this app's own language hint convention, e.g. project.language) -> Sarvam's BCP-47
// source language codes (docs.sarvam.ai's supported list: hi-IN, bn-IN, kn-IN, ml-IN, mr-IN,
// od-IN, pa-IN, ta-IN, te-IN, gu-IN, en-IN).
const SARVAM_LANG_MAP = {
  hi: 'hi-IN', bn: 'bn-IN', kn: 'kn-IN', ml: 'ml-IN', mr: 'mr-IN',
  or: 'od-IN', pa: 'pa-IN', ta: 'ta-IN', te: 'te-IN', gu: 'gu-IN', en: 'en-IN',
};

function supportsLanguage(language) {
  return !!SARVAM_LANG_MAP[(language || '').toLowerCase()];
}

// Prefers cutting through a detected silence gap close to (but not past) the 30s cap, maximizing
// chunk length while still landing on a quiet moment; falls back to a hard cut at the cap if no
// silence gap is found in range (a chunk missing one clean cut point is still far better than
// exceeding Sarvam's hard limit and having the whole chunk rejected).
function planChunks(durationSec, silences, maxChunkSec) {
  const chunks = [];
  let cursor = 0;
  while (cursor < durationSec - 0.05) {
    if (durationSec - cursor <= maxChunkSec) { chunks.push({ start: cursor, end: durationSec }); break; }
    const hardLimit = cursor + maxChunkSec;
    let cut = null;
    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      if (mid > cursor + 1 && mid <= hardLimit && (cut === null || mid > cut)) cut = mid;
    }
    const end = cut || hardLimit;
    chunks.push({ start: cursor, end });
    cursor = end;
  }
  return chunks;
}

// Tries a couple of plausible Sarvam response shapes for word-level timing before giving up —
// see the module header comment for why this is defensive rather than a single confident parse.
function parseSarvamWords(data, chunkDurationSec) {
  const text = (data.transcript || data.text || '').trim();
  const ts = data.timestamps;

  // Shape A: parallel arrays — { timestamps: { words:[...], start_time_seconds:[...], end_time_seconds:[...] } }
  if (ts && Array.isArray(ts.words) && Array.isArray(ts.start_time_seconds) && ts.words.length === ts.start_time_seconds.length) {
    return {
      text,
      words: ts.words.map((w, i) => ({ word: w, start: Number(ts.start_time_seconds[i]) || 0, end: Number((ts.end_time_seconds || [])[i]) || Number(ts.start_time_seconds[i]) || 0 })),
    };
  }
  // Shape B: array of {word, start_time_seconds, end_time_seconds} objects, either at data.timestamps or data.word_timestamps
  const arr = Array.isArray(ts) ? ts : Array.isArray(data.word_timestamps) ? data.word_timestamps : null;
  if (arr && arr.length && arr[0] && (arr[0].word !== undefined)) {
    return {
      text,
      words: arr.map(w => ({ word: w.word, start: Number(w.start_time_seconds ?? w.start) || 0, end: Number(w.end_time_seconds ?? w.end) || 0 })),
    };
  }
  // Fallback: no usable word-level timing in this response — split the transcript text evenly
  // across the chunk's duration, flagged approximate (same convention as the existing
  // Whisper-segments-only fallback in marketingWordsFromTranscription).
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { text, words: [] };
  const span = chunkDurationSec / tokens.length;
  return { text, words: tokens.map((t, i) => ({ word: t, start: i * span, end: (i + 1) * span, approximate: true })) };
}

async function transcribeChunk(chunkPath, langCode, apiKey) {
  const buf = fs.readFileSync(chunkPath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'chunk.mp3');
  form.append('model', 'saarika:v2.5');
  form.append('language_code', langCode || 'unknown');
  form.append('with_timestamps', 'true');
  const r = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST', headers: { 'api-subscription-key': apiKey }, body: form,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || data?.message || `Sarvam HTTP ${r.status}`);
  return data;
}

async function transcribeWithSarvam(sourceUrl, language, env) {
  const apiKey = env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY is not set on the render pipeline.');
  const langCode = SARVAM_LANG_MAP[(language || '').toLowerCase()] || 'unknown';

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-sarvam-'));
  try {
    const srcPath = path.join(workDir, 'source' + (path.extname(new URL(sourceUrl).pathname) || '.mp4'));
    await downloadToFile(sourceUrl, srcPath);
    const audioPath = path.join(workDir, 'audio.mp3');
    await run('ffmpeg', ['-y', '-i', srcPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audioPath]);

    const durationSec = await getDurationSec(audioPath);
    const silences = await detectSilence(audioPath, 0, durationSec);
    const chunks = planChunks(durationSec, silences, MAX_CHUNK_SEC);

    const allWords = [];
    const allText = [];
    let detectedLang = null;
    for (const chunk of chunks) {
      const chunkPath = path.join(workDir, `chunk-${Math.round(chunk.start * 1000)}.mp3`);
      await run('ffmpeg', ['-y', '-i', audioPath, '-ss', String(chunk.start), '-to', String(chunk.end), '-c:a', 'libmp3lame', '-b:a', '64k', chunkPath]);
      let data;
      try {
        data = await transcribeChunk(chunkPath, langCode, apiKey);
      } catch (err) {
        console.error(`Sarvam chunk [${chunk.start}-${chunk.end}] failed, skipping:`, err.message);
        continue; // one bad chunk shouldn't fail the whole transcription
      }
      if (!detectedLang && data.language_code) detectedLang = String(data.language_code).split('-')[0];
      const parsed = parseSarvamWords(data, chunk.end - chunk.start);
      if (parsed.text) allText.push(parsed.text);
      parsed.words.forEach(w => allWords.push({ ...w, start: w.start + chunk.start, end: w.end + chunk.start, ...(w.approximate ? { approximate: true } : {}) }));
    }
    if (!allText.length && !allWords.length) throw new Error('Sarvam transcription returned no usable result for any chunk.');

    return { language: detectedLang || (language || null), text: allText.join(' '), words: allWords };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { transcribeWithSarvam, supportsLanguage };
