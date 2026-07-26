// Burns captions in via a generated .ass file + ffmpeg's `subtitles` filter — ASS (not SRT/WebVTT)
// specifically because its karaoke tags (\k) are what make the "word-highlight" caption
// animation (matching MARKETING_STYLE_PRESETS in worker.js) a real per-word color reveal instead
// of a static block of text, and its style directives cover font/color/position/background in
// one place without hand-drawing anything with drawtext.
const fs = require('fs');

function toAssColor(cssColor, fallback = '#FFFFFF') {
  const c = (cssColor || fallback).trim();
  let r = 255, g = 255, b = 255, a = 0; // ASS alpha: 00 = fully opaque, FF = fully transparent
  const hexMatch = /^#([0-9a-f]{6})$/i.exec(c);
  const rgbaMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)$/i.exec(c);
  if (hexMatch) {
    const hex = hexMatch[1];
    r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
  } else if (rgbaMatch) {
    r = parseInt(rgbaMatch[1], 10); g = parseInt(rgbaMatch[2], 10); b = parseInt(rgbaMatch[3], 10);
    const alpha = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
    a = Math.round((1 - alpha) * 255);
  }
  const hex2 = n => n.toString(16).padStart(2, '0').toUpperCase();
  // ASS colour order is &HAABBGGRR& — blue/green/red swapped from CSS's RGB.
  return `&H${hex2(a)}${hex2(b)}${hex2(g)}${hex2(r)}&`;
}

function assEscape(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
}

function toAssTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}`;
}

const ALIGNMENT_BY_POSITION = { bottom: 2, middle: 5, top: 8 };

// words: [{word, start, end}] already remapped to the OUTPUT timeline (post trim/silence-cut).
// style: one of MARKETING_STYLE_PRESETS/marketing_brand_styles' config shape.
function buildAssSubtitles(words, style, { resolutionW, resolutionH }) {
  const fontName = (style.font || 'Arial').split(',')[0].replace(/['"]/g, '').trim() || 'Arial';
  const fontSize = Math.round(resolutionH * 0.045); // ~86px at 1920 tall — readable at short-form scale
  const primary = toAssColor(style.text_color, '#FFFFFF');
  const highlight = toAssColor(style.highlight_color || style.text_color, '#FFE600');
  const alignment = ALIGNMENT_BY_POSITION[style.position] || 2;
  const marginV = Math.round(resolutionH * (style.position === 'top' ? 0.08 : style.position === 'middle' ? 0.46 : 0.1));
  const hasBox = style.bg_style === 'pill' || style.bg_style === 'box';
  const backColour = hasBox ? toAssColor(style.bg_color, '#000000') : '&H00000000&';
  const borderStyle = hasBox ? 3 : 1; // 3 = opaque box behind text; 1 = outline + shadow (ASS has no native rounded-pill shape — 'pill' renders as a square box, documented limitation)

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${resolutionW}
PlayResY: ${resolutionH}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primary},${highlight},&H00000000&,${backColour},-1,0,0,0,100,100,0,0,${borderStyle},3,1,${alignment},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = style.animation === 'word-highlight'
    ? buildKaraokeLines(words, highlight, primary)
    : style.animation === 'pop'
      ? buildPopLines(words)
      : buildPlainLines(words);

  return header + events.join('\n') + '\n';
}

// Groups words into short caption lines (max words / max span, whichever comes first — mirrors
// how short-form captions chunk 3-6 words at a time rather than one word or a whole sentence).
function groupWords(words, { maxWords = 5, maxSpanSec = 2.6 } = {}) {
  const groups = [];
  let current = [];
  for (const w of words) {
    if (current.length && (current.length >= maxWords || (w.end - current[0].start) > maxSpanSec)) {
      groups.push(current);
      current = [];
    }
    current.push(w);
  }
  if (current.length) groups.push(current);
  return groups;
}

// \k tags reveal PrimaryColour progressively over SecondaryColour as each word is spoken — set
// PrimaryColour to the highlight color and SecondaryColour to the base text color above so the
// visible effect is "each word lights up as it's said", the standard karaoke-captions look.
function buildKaraokeLines(words, highlightAssColor, baseAssColor) {
  const groups = groupWords(words);
  return groups.map(group => {
    const lineStart = group[0].start, lineEnd = group[group.length - 1].end;
    const text = group.map(w => `{\\k${Math.max(1, Math.round((w.end - w.start) * 100))}}${assEscape(w.word)}`).join(' ');
    return `Dialogue: 0,${toAssTime(lineStart)},${toAssTime(lineEnd)},Default,,0,0,0,,${text}`;
  });
}

// One Dialogue event per word, each with a brief scale-up-then-settle \t transform — a real
// per-word "pop" rather than a static line, at the cost of more subtitle events than the
// karaoke/plain modes (one per word instead of one per ~5-word group).
function buildPopLines(words) {
  return words.map(w => {
    const dur = Math.max(0.05, w.end - w.start);
    const popMs = Math.min(180, Math.round(dur * 1000 * 0.4));
    const text = `{\\fscx130\\fscy130\\t(0,${popMs},\\fscx100\\fscy100)}${assEscape(w.word)}`;
    return `Dialogue: 0,${toAssTime(w.start)},${toAssTime(w.end)},Default,,0,0,0,,${text}`;
  });
}

function buildPlainLines(words) {
  const groups = groupWords(words);
  return groups.map(group => {
    const lineStart = group[0].start, lineEnd = group[group.length - 1].end;
    const text = group.map(w => assEscape(w.word)).join(' ');
    return `Dialogue: 0,${toAssTime(lineStart)},${toAssTime(lineEnd)},Default,,0,0,0,,${text}`;
  });
}

function writeAssFile(filePath, words, style, resolution) {
  const content = buildAssSubtitles(words, style, resolution);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

module.exports = { buildAssSubtitles, writeAssFile, toAssColor, toAssTime, assEscape };
