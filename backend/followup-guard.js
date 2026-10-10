// Follow-up guard for recovery.js — Settings → Bot behaviour → Leadvyne v2 → "Follow-up guard"
// (bot_config.v2_followup_guard, only with bot_config.leadvyne_v2). Mirrors the Worker's
// engineV2FollowupGuardOn / followupWithinQuietHours / engineChatLanguage
// (cloudflare-worker/worker.js) — this Node process can't import the Worker, so keep them in step.
// Off (every other client) leaves recovery.js exactly as before.

function botConfig(client) {
  try { return JSON.parse(client?.bot_config || '{}') || {}; } catch { return {}; }
}

export function followupGuardOn(client) {
  const bc = botConfig(client);
  return bc.leadvyne_v2 === true && bc.v2_followup_guard === true;
}

// Client's follow-up send window (default 18:00–21:00 in bot_config.timezone, default Asia/Kolkata).
export function withinSendWindow(client, now = new Date()) {
  const bc = botConfig(client);
  if (bc.followup_quiet_hours_enabled === false) return true;
  const tz = bc.timezone || 'Asia/Kolkata';
  const start = Number.isFinite(bc.followup_window_start_hour) ? bc.followup_window_start_hour : 18;
  const end = Number.isFinite(bc.followup_window_end_hour) ? bc.followup_window_end_hour : 21;
  const hour = new Date(now.toLocaleString('en-US', { timeZone: tz })).getHours();
  return start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

export function scriptLanguage(text) {
  const t = String(text || '');
  if (/[\u0D00-\u0D7F]/.test(t)) return 'ml';
  if (/[\u0900-\u097F]/.test(t)) return 'hi';
  if (/[\u0600-\u06FF]/.test(t)) return 'ar';
  if (/[\u0B80-\u0BFF]/.test(t)) return 'ta';
  if (/[\u0C80-\u0CFF]/.test(t)) return 'kn';
  if (/[\u0C00-\u0C7F]/.test(t)) return 'te';
  if (/[\u0980-\u09FF]/.test(t)) return 'bn';
  return /[A-Za-z]/.test(t) ? 'en' : '';
}

// The language the customer is reading: our side's most recent message, else the fallback.
export function chatLanguage(history, fallback) {
  for (let i = (history || []).length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role !== 'assistant' || typeof m.content !== 'string') continue;
    const lang = scriptLanguage(m.content);
    if (lang) return lang;
  }
  return fallback || '';
}

const LANG_NAMES = { en: 'English', ml: 'Malayalam (Malayalam script)', hi: 'Hindi (Devanagari script)', ar: 'Arabic', ta: 'Tamil', kn: 'Kannada', te: 'Telugu' };

// Extra rules for the AI rewrite: don't answer for the customer, keep the chat's language.
export function guardPromptRules(lang) {
  const name = LANG_NAMES[lang] || '';
  return ' RULES: If our last message asked a question the customer has not answered, gently ask that same question again — never assume their answer, never skip ahead to a next step (call, demo, meeting time, link) they have not agreed to in their own words.'
    + (name ? ` Write ONLY in ${name}, the language this chat is in.` : ' Write in the same language as our last message in the conversation.');
}
