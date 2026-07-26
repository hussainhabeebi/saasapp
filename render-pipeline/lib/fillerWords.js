// Filler-word removal (spec.filler_word_cut) — a zero-cost extension of the existing silence-cut
// machinery (lib/timeline.js's computeKeepSegments doesn't care WHY a range should be cut, only
// that it should be), not a new API or model. Pure function, no I/O: takes the already-fetched
// transcript's word list and returns the time ranges its filler words occupy.
//
// English + common Manglish (Malayalam-in-Latin-script) hesitations. Best-effort and heavily
// English-biased — "filler word" as a vocabulary is much better established for English than for
// Malayalam script, and guessing a Malayalam-script filler-word list from training data alone
// isn't something to ship without a native-speaker review; a real Malayalam list is a reasonable
// future addition, not attempted here.
const FILLER_WORDS = new Set([
  'um', 'umm', 'uhm', 'uh', 'uhh', 'hmm', 'hmmm', 'like', 'ah', 'ahh', 'er', 'erm',
]);

function isFillerWord(word) {
  const clean = (word || '').toLowerCase().replace(/[^\w]/g, '').trim();
  return FILLER_WORDS.has(clean);
}

function findFillerWordRanges(words, padSec = 0.05) {
  return (words || [])
    .filter(w => isFillerWord(w.word))
    .map(w => ({ start: Math.max(0, (Number(w.start) || 0) - padSec), end: (Number(w.end) || 0) + padSec }));
}

module.exports = { isFillerWord, findFillerWordRanges };
