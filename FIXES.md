# Fixes Log

A chronological record of real, production-observed bugs fixed in this repo — what broke, what
changed, and why it must not be casually reverted. This is the index; the full reasoning for each
fix also lives as an inline comment right above the code it touches (this repo's existing
convention) — read that for the complete story, use this file to find it and to check "has this
area already burned someone before" before you start editing.

**Rule: before modifying any function or file listed below, read its entry first.** If your change
would undo what's described here, you're about to reintroduce a bug a real customer already hit.

Automated coverage for the entries below: `cloudflare-worker/worker.test.js` (`npm test` from
`cloudflare-worker/`) and `frontend/tests/*.spec.js` (`npm test` from `frontend/`, needs
`npx playwright install chromium` once). Both run in CI on every PR — see
`.github/workflows/ci.yml`.

---

### 1 — [backend] Anti-loop threshold tightened from 3 identical replies to 2
**Area:** `engineGetLeadState` (`cloudflare-worker/worker.js`)
**Broke:** A WhatsApp customer got the exact same scripted reply sent 3 times in a row before the
bot's loop detector escalated to a human — detection itself required 3 identical assistant replies
to already be in `ConvHistory` before the *next* turn would force a handover.
**Fix:** Requires only 2 identical replies now, halving how many duplicates a stuck customer sees.
**Don't revert:** Raising this back to 3 (or higher) directly increases how many duplicate replies
a real customer sees before the bot gives up and hands off.

### 2 — [backend] Ecom FAQ: stop repeating clarifying questions, ground options to catalog
**Area:** `engineBuildFaqSystemPrompt`, ecommerce branch (`cloudflare-worker/worker.js`)
**Broke:** A customer asked about "REPOSE" (a brand with several models), got asked "which model?",
replied "any"/"only 1" (real answers, not a model name), and got the identical clarifying question
back twice more instead of a recommendation.
**Fix:** Added an explicit instruction: if the customer's reply to a product-choice question is a
vague non-answer, stop asking and recommend one real catalog product instead. Also: never name an
option that isn't literally in the catalog.
**Don't revert:** Removing this reintroduces the exact repeat-question loop for every industry using
the ecommerce FAQ branch.

### 3 — [backend] Ecom: send product description on any product match, not just on explicit ask
**Area:** `engineMaybeSendProductDescription`, `handleEngineWebhook` (`cloudflare-worker/worker.js`)
**Broke:** The verbatim product Description field only ever sent when the customer's own wording
matched a keyword regex ("more details", "full description", etc.), with no dedup — inconsistent
and easy to never trigger at all.
**Fix:** Now sends whenever a product is confidently matched (same trigger the photo/media bundle
uses), capped to once per (lead, product, calendar day) via the same
`engineClaimProductImageForToday` claim the photo already uses.
**Don't revert:** Reintroducing the keyword gate silently stops the description from ever reaching
most customers, since "tell me about X" rarely contains the exact regex keywords.

### 4 — [backend] Ecom: description sent before the photo/media bundle, not after
**Area:** `handleEngineWebhook`, order-detection branches (`cloudflare-worker/worker.js`)
**Broke:** The description (fix #3) was appended at the very end of the turn, after
testimonials/promos — arriving well after the photos/audio/video/PDF it's supposed to introduce.
**Fix:** Moved inline, sent immediately before the extra-media bundle at each order-detection
branch — customer now sees description → images → audio → video → PDF, in that order.
**Don't revert:** Moving the description send back to end-of-turn re-separates it from the media it
describes.

### 5 — [backend] WhatsApp list rows: carry the untruncated label in a description field
**Area:** `engineSendChatwootQuickReply` (`cloudflare-worker/worker.js`)
**Broke:** A long option name ("Semi Medicated Orthopedic Mattress") truncates to "Semi
Medicated…" in the 24-char WhatsApp list-row title limit — a hard platform cap, not something this
app can raise.
**Fix:** WhatsApp list rows (not plain reply buttons) carry a separate ~72-char `description` line;
whenever a title is actually truncated, the fuller text now goes there too.
**Don't revert:** `engineTruncateButtonTitle`'s cap (20 for buttons, 24 for lists) is a real Meta
API limit — do not raise it; a payload exceeding it gets silently rejected by Meta, not gracefully
truncated.
**Tested:** `worker.test.js` → `engineTruncateButtonTitle`.

### 6 — [backend] Deterministic quick-reply tap resolution
**Area:** `handleEngineWebhook`, right after `engineResolveUserText` (`cloudflare-worker/worker.js`)
**Broke:** Several quick-reply call sites gave an item a `value` longer/different from its
necessarily-short `title` (e.g. title `"🛒 Order this"`, value `"I want to order <full product
name>"`), assuming `value` is what a tap sends back. It isn't — WhatsApp/Chatwoot echoes the
tapped item's **title**. A tap landed as just the short title, leaving the AI to re-guess a
product from a fragment, unreliably.
**Fix:** `engineBuildLeadUpsertBody` already records each turn's own quick-reply `options`
(title+value) onto its ConvHistory entry — a reply that exactly matches one of the *previous*
turn's option titles now gets swapped back to that option's fuller `value` before
`detectOrderSignal`/`engineClassifyIntent` ever run.
**Don't revert:** Without this, every quick-reply flow degrades to hoping the AI classifier
correctly re-infers intent from a bare, truncated title.

### 7 — [backend] Deterministic brand-level picker
**Area:** `detectOrderSignal`, category-enquiry branch of `handleEngineWebhook`
(`cloudflare-worker/worker.js`)
**Broke:** A category with multiple brands (Mattress: Cloudnine Hybrid / PEPS / REPOSE) had no
deterministic path for the brand itself — a bare brand name has no `category` for the classifier to
key off, so it fell to the free-form FAQ LLM, which doesn't reliably attach buttons. Real failure:
"Are you interested in Cloudnine Hybrid, or PEPS or REPOSE?" as plain text, and a bare "REPOSE"
reply afterward getting a generic FAQ answer instead of a model list.
**Fix:** `detectOrderSignal` now also recognizes a bare brand name from context; a category with
2+ real brands offers them as a tappable picker first, then the existing variant/model picker runs
against just that brand's products.
**Don't revert:** Removing the `brand` field from `detectOrderSignal`'s schema silently drops this
entire path back to the free-text failure mode.

### 8 — [backend + frontend] Qualifying questions can have real tappable choices
**Area:** `engineQualQuestionOptions`, `handleEngineWebhook`'s `qualify`/`qualify_next` routes,
`engineBuildNativeFormFlowJson` (`cloudflare-worker/worker.js`); qualifying-questions editor
(`frontend/dashboard.html`)
**Broke:** A business-configured qualifying question phrased as a choice ("Do you need a mattress,
a wooden bed, or something else?") had no way to become buttons — `qual_questions` entries only
ever supported `{text, optional}`, no structured choices.
**Fix:** Entries can now carry `options: string[]`; `dashboard.html` gained a "Choices" field
(comma-separated, blank = unchanged free-text behavior) per question. When set, both qualifying
routes send it as a real picker; Native Forms renders it as a `RadioButtonsGroup` instead of a
`TextInput`.
**Don't revert:** Removing the `options` field from the qual_questions shape, or the Choices input
in the editor, silently breaks any client who has configured one.
**Tested:** `worker.test.js` → `engineQualQuestion*`, `engineRouteFlow` qualify_next; `frontend/tests/qual-questions.spec.js`.

### 9 — [backend] Fix: stored quick-reply options didn't match what was actually sent
**Area:** `engineSendChatwootQuickReply` and all 7 of its call sites (`cloudflare-worker/worker.js`)
**Broke:** The send function computed its own truncated/deduped `{title, value}` list internally
but never returned it — every call site stored its **own pre-truncation** `items` as
`routing.quickReplies`. A long title got stored one way (full label) while WhatsApp displayed and
echoed back the truncated version — fix #6's tap resolution could never match, so a tap on "Semi
Orthopedic…" re-sent the whole picker instead of resolving that product.
**Fix:** `engineSendChatwootQuickReply` now returns what it actually sent (or `null` on any
fallback-to-plain-text path); every call site sets `routing.quickReplies` from that return value.
**Don't revert:** Any call site that goes back to building its own `items` for `routing.quickReplies`
independently of this function's return value reopens the exact mismatch.

### 10 — [backend] FAQ: extract plain-English choice questions when OPTIONS: marker is missing
**Area:** `engineExtractPlainOptionsFromReply`, FAQ dispatch in `handleEngineWebhook`
(`cloudflare-worker/worker.js`)
**Broke:** The `OPTIONS:` marker is the FAQ LLM's own choice to tag a reply as a menu, and it
doesn't reliably remember to — even for the exact "skincare, wellness, or diet plan options
today?" phrasing given as the textbook example in its own instructions. Sent as plain prose with
nothing to tap.
**Fix:** A small, focused classification call reads the already-generated reply and extracts a
plain-English "X, Y, or Z?" question into option labels — any industry, last resort only, gated
behind a cheap `?`/`؟` pre-check so most non-question replies skip the extra call entirely.
**Don't revert:** Removing this drops button coverage back to "only when the AI remembers the
marker," which real testing showed is unreliable.

### 11 — [backend] value length cap, qual-option localization, extraction for unconfigured questions
**Area:** `engineSendChatwootQuickReply`, `engineLocalizeOptions`, `qualify`/`qualify_next` routes
(`cloudflare-worker/worker.js`)
**Broke three things:**
1. `value` becomes a list row's/button's own `id` in the real Meta payload (200/256-char limits) —
   several callers deliberately build a longer `value` than the title (e.g. "I want to order
   \<full product name\>"), so an unusually long product name was an uncapped risk of silent Meta
   rejection.
2. A client's own `qual_questions[i].options` were typed once in the business's language, same as
   the question text (already localized) — the choices weren't.
3. The *original* Cloudnine Beddings failure was never actually closed: `qual_questions[0]` was
   phrased as a choice but never had `options` filled in (it's opt-in/manual, predates the field).
**Fix:** (1) `value` capped at 200 chars, same defensive treatment as `title`. (2)
`engineLocalizeOptions` batches every option through one translation call. (3) Both qualifying
routes fall back to fix #10's extraction on the actual text about to be sent whenever no
`options` are configured.
**Don't revert:** Removing the `value` cap reopens a silent-rejection risk; removing the
localization or extraction fallback reopens their respective original failures.

### 12 — [backend] Fix Malayalam (and other complex-script) button taps never resolving
**Area:** Tap-resolution comparison in `handleEngineWebhook`, collision check in
`engineSendChatwootQuickReply` (`cloudflare-worker/worker.js`)
**Broke:** A tap on a translated (fix #11) Malayalam option never resolved, even though the tapped
title was visibly, correctly displayed and identical to what was sent. Complex scripts can encode
the exact same visible text as different Unicode code point sequences (precomposed vs. decomposed
conjuncts/vowel signs) — a plain string comparison sees those as different strings. Invisible with
English/Latin text.
**Fix:** Both comparisons call `.normalize('NFC')` on each side before comparing.
**Don't revert:** Removing the `.normalize()` calls silently breaks every non-Latin-script quick
reply again, in a way that won't show up in English-only testing.

### 13 — [backend] Detect near-duplicate bot replies, not just byte-identical, for anti-loop
**Area:** `engineTextSimilarity`, `engineGetLeadState`'s `looping` check
(`cloudflare-worker/worker.js`)
**Broke:** A customer replied "yes" to a product pitch ending in a question; the FAQ LLM
regenerated essentially the same pitch/question with slightly different wording each time. Fix
#1's loop detector required byte-identical text, which AI-generated text almost never is even when
saying the same thing — it never fired; this specific, common failure had **zero** safety net.
**Fix:** `engineTextSimilarity` (cheap word-overlap ratio, no extra LLM call) — `looping` now fires
at ≥70% similarity instead of requiring exact equality.
**Don't revert:** Reverting to exact-equality-only silently removes loop protection for the most
common real-world case (reworded AI repeats), while looking identical to fix #1 in a diff.
**Tested:** `worker.test.js` → `engineTextSimilarity`, `engineRouteFlow` anti-loop escalation.

### 14 — [backend] Root-cause prompt fix + proactive alerting for loop escalations
**Area:** `engineBuildFaqSystemPrompt` (shared instructions), `engineRouteFlow`'s `loopDetected`,
`handleEngineWebhook`/`handleInstagramWebhook` (`cloudflare-worker/worker.js`)
**Broke:** Fix #13 is a safety net for *after* a loop starts — it doesn't stop one from starting.
Every fix in this entire log started from a business owner manually screenshotting a stuck
conversation; by the time that happens, other customers may have hit the same thing silently.
**Fix:** Two additions, at two different levels — (1) a new shared FAQ instruction: if the model's
own previous message asked permission to share more ("would you like to know more?") and the
reply is a plain affirmative, give the details instead of repeating the offer. (2) `engineRouteFlow`
returns `loopDetected` (purely additive — never folded into `humanReason`, which already has
specific meaning elsewhere); both webhook handlers report it to the existing `reportOpsError`
operator channel (Slack/email) whenever it fires.
**Don't revert:** Removing the prompt instruction reopens the specific, common way loops start;
removing the alert means loops go back to being invisible until someone screenshots one. **Needs
`OPS_ALERT_WEBHOOK_URL` and/or `OPS_ALERT_EMAIL`/`RESEND_API_KEY` actually set** to deliver — check
this is configured, not just that the code is present.
**Tested:** `worker.test.js` → `engineRouteFlow` anti-loop escalation (`loopDetected`).

### 15 — [backend] Retry a near-duplicate reply before it's ever sent, not just after
**Area:** `engineCallLlmAvoidingRepeat` (new), its 5 call sites in `handleEngineWebhook`/
`handleInstagramWebhook` (FAQ/ecom_faq/travel_faq/saas_faq route, objection route, product-enquiry
route) (`cloudflare-worker/worker.js`)
**Broke:** Fix #14's prompt instruction is a request, not a guarantee — the exact same Wellness
Virtue case recurred after #14 shipped: "would you like to know more?" → customer says "ok" →
essentially the same pitch/question comes back. Fix #13's `looping` flag can only detect this
*after* both near-duplicate messages already exist in history (it looks backward at the START of a
turn), so it can escalate on the 3rd customer turn but can't stop the 2nd bot message — the one the
customer actually sees repeated — from going out in the first place.
**Fix:** `engineCallLlmAvoidingRepeat` wraps `engineCallLlm`: generate the reply, compare it against
the bot's own immediately-preceding message with `engineTextSimilarity` (same ≥0.7 threshold as fix
#13's `looping`), and if it's a near-duplicate, retry once with an explicit instruction quoting the
rejected text and demanding new information or a different question. Fully fail-open — any retry
failure just falls back to the original reply rather than blocking the turn.
**Don't revert:** This is the only check that runs *before* a reply is sent, not after — removing it
reopens the specific recurring failure #13/#14 were both written to close, even with both of those
still in place.
**Tested:** `engineTextSimilarity` (the comparison it relies on) already covered in
`worker.test.js`; `engineCallLlmAvoidingRepeat` itself calls the network (Gemini/OpenRouter) and is
intentionally left out of the pure-logic suite, consistent with this file's existing scope.

### 16 — [backend] Diagnostic logging for an unresolved quick-reply tap
**Area:** Tap-resolution block in `handleEngineWebhook`, right where fix #12's comparison runs
(`cloudflare-worker/worker.js`)
**Broke (a gap, not a bug):** "The button tap didn't do anything" was reported multiple times
(fixes #6, #9, #12 all came from this same class of report), and each time there was no way to
tell, from a screenshot alone, whether the tap (a) reached this webhook but didn't match any
offered option, or (b) never reached Chatwoot/this webhook at all — those two failure modes need
completely different fixes (one is a bug in this repo, the other is a Chatwoot/Meta delivery
issue outside it), and guessing which one happened wastes a round of speculative fixes.
**Fix:** Whenever a picker was just shown and the reply doesn't match any of its options (even
after fix #12's normalization), log it (`engine_event_log`, reason `quick-reply-not-matched`,
Settings → Logs) — diagnostic only, never blocks or alters the turn. If a report comes in and
**nothing** appears in Settings → Logs for that phone/time (not even this entry), the problem is
upstream of this codebase — check Chatwoot's own conversation view and Meta's delivery logs next,
not another code fix here.
**Don't revert:** Removing this reopens the exact "which layer failed?" guessing game.

### 17 — [backend] "✓ Replied" in Settings → Logs didn't mean the message was actually delivered
**Area:** `engineSendChatwootReply`, `engineSendChatwootImageReply`, `engineSendChatwootAudioReply`,
`engineSendChatwootQuickReply`, `engineDeliverReply` (`cloudflare-worker/worker.js`)
**Broke:** Following up on fix #16's diagnostic: a real case where a customer's tap genuinely
reached the engine (a `✓ Replied / ecom_faq` row was logged, matching timestamp, 8.4s round trip)
but nothing arrived on WhatsApp. Root cause: `engineLogAnalytics` (the source of every "Replied"
row) is called **unconditionally** at the end of a turn, regardless of whether the actual Chatwoot
send succeeded — every one of the 4 send functions already caught its own failures and reported
them to `reportOpsError` (operator-only Slack/email), but that's invisible in the client-facing
Settings → Logs a business owner actually checks. Same gap for `bot_reply_disabled='Yes'`
(Settings → Bot Auto-Reply off): `engineDeliverReply` intentionally suppresses the send for that
client, but the turn still finishes and still logs "Replied."
**Fix:** All 4 send functions now return `true`/`false` reflecting whether something actually went
out (not just "didn't throw"), and log a specific reason to `engine_event_log`
(`send-failed`/`send-skipped-no-setup`/`bot-reply-disabled`) whenever they don't deliver — visible
in Settings → Logs right alongside (not instead of) the still-present "Replied" analytics row, so a
business owner can now see *why* nothing arrived instead of just seeing an unexplained "Replied."
`engineSendChatwootQuickReply` distinguishes `false` (nothing delivered at all) from `null` (fell
back to plain text successfully — not a failure, just not buttons) so its existing
`routing.quickReplies` contract (fix #9) is unaffected.
**Don't revert:** Making these functions return `undefined` again (or dropping the `logEngineSkip`
calls) silently brings back "Replied" as an untrustworthy signal — this was a real, confirmed cause
of at least one "button didn't do anything" report, not a hypothetical.

### 18 — [backend] The rate limiter measured time since the bot's own reply, not since the customer's message
**Area:** Rate-limit check in `handleEngineWebhook`, `engineGetLeadState`, `engineBuildLeadUpsertBody`
call site (`cloudflare-worker/worker.js`)
**Broke:** With Bot Auto-Reply confirmed on and no `quick-reply-not-matched` or `send-failed` row in
Settings → Logs for the tap (ruling out fixes #16 and #17), some button taps still got zero
response. Root cause: the rate limiter compared `Date.now()` against `LEADS.LastMsgAt`, but
`LastMsgAt` is stamped with "now" unconditionally at the end of **every** turn — including the
bot's own reply, which real logs show taking 8+ seconds (LLM + NocoDB round trips). So the clock
this check measured was "time since the last activity of either party," not "time since the
customer last wrote in." A customer tapping a quick-reply button they're already looking at (no
typing needed, often well under the 4s default `rate_limit_ms`) could land inside the cooldown
window the bot's *own* prior reply had just reset, and get silently skipped
(`rate-limited` in `engine_event_log`) with nothing sent — this matches "Bot replay on but some
replays from button not reaching to Bot or Chatwoot" exactly.
**Fix:** Added `LEADS.LastCustomerMsgAt`, a separate column stamped only from the customer's own
message arrival time (`startMs`, captured at the very top of `handleEngineWebhook`, before any
LLM/NocoDB work) — never from the bot's reply. `engineGetLeadState` now returns
`lastCustomerMsgAt`, and the rate-limit check reads that instead of `lastMsgAt`. `LastMsgAt` itself
is untouched and still reflects the most recent activity for any other code that relies on it.
**Don't revert:** Switching the rate-limit check back to `state.lastMsgAt` reopens the exact race:
the bot's own reply resets the clock the customer's immediate next tap gets measured against.
**Not yet done:** No direct unit test — the check lives inline in `handleEngineWebhook`, which
isn't a pure/exported function. If it's ever extracted, add a test asserting the rate limit is
measured against the customer's last message time, not the bot's.
**Not yet done:** `engineLogAnalytics`'s own `IsError` field still doesn't reflect delivery failure
— it's a separate, larger change (threading a success signal through ~15 different reply-dispatch
branches in `handleEngineWebhook`) that was deliberately scoped out here to ship the diagnostic
value now at low risk. The new `logEngineSkip` rows are the actual fix; "Replied" itself is still
just "didn't crash," so keep reading both columns together.
**Tested:** `worker.test.js` → `engineSendChatwootReply` return value (mocked `fetch`).

---

## Data contracts (frontend ⇄ backend)

Shapes agreed on implicitly between `dashboard.html` (writes) and `worker.js` (reads) — nothing
enforces these stay in sync besides this note and the tests above. Check both sides before changing
either.

- **`CLIENTS.qual_questions`** (JSON string) — array of either a plain string (legacy, always
  required, no choices) or `{text: string, optional: boolean, options: string[]}`. `options` empty
  or absent = free text. See fix #8, #11.
