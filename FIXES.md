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

### 16 — [backend] Durable customer facts, not just raw transcript + a summary
**Area:** `engineMaybeExtractCustomerFacts`, `engineCustomerFactsBlock` (new), `engineGetLeadState`'s
`customerFacts`, both lead-upsert call sites in `handleEngineWebhook`/`handleInstagramWebhook`
(`cloudflare-worker/worker.js`)
**Broke:** Nothing broke — this is the requested follow-up to #13-#15: "memory like a human" and
"connection between each chat." Before this, the only durable memory was raw ConvHistory (last 40
turns) and `ConvSummary`, a rolling prose summary that only ever runs once a conversation crosses 40
messages — the vast majority of real conversations never do, so most customers got no durable memory
at all beyond the raw recent-turns window. A human rep doesn't re-read a transcript before replying —
they recall specific facts (allergies, budget, preferred language, "already told them X") instantly.
**Fix:** `engineMaybeExtractCustomerFacts` runs every 6 turns starting almost immediately (not gated
behind the 40-turn threshold), re-reading the last 20 messages, merging with whatever was already
extracted (so a later contradiction updates/drops a fact instead of both coexisting), and persists a
capped JSON array of short fact strings in a new `Customer Facts` lead column (self-healing, same
pattern as `ConvSummary`/`OrderCollect`/`Last Product Sku`). `engineCustomerFactsBlock` injects a
"## What We Know About This Customer" section into all three reply prompts (FAQ/objection/enquiry),
paired with an explicit instruction not to ask for or repeat what's already known there. Because this
lives on the same lead row as `ConvHistory`, it survives a Resolve/Reopen cycle and an opt-out/resub
(neither clears it) — continuity across separate conversation sessions on the same channel, without
needing new infrastructure.
**Known limitation:** This does not unify identity *across channels* — a customer on WhatsApp and
Instagram to the same business is two separate lead rows (keyed by phone vs. IgId) with no shared
identifier to merge them on; that would need the customer to provide a matching identifier (email/
phone) in some form, which isn't reliably available today.
**Don't revert:** Removing this reopens the exact "memory like a human" gap this session's fixes were
building toward, and weakens the anti-repeat instructions in the FAQ/enquiry/objection prompts, which
now lean on it to know what's already been established.
**Tested:** Not covered in `worker.test.js` — `engineMaybeExtractCustomerFacts` calls the network
(same reasoning as #15's `engineCallLlmAvoidingRepeat`); `engineCustomerFactsBlock` is a small pure
formatter without its own documented failure case, consistent with this file's per-bug (not
per-helper) test scope.

### 17 — [backend] Reject a hallucinated link before it's ever sent
**Area:** `engineFindHallucinatedLink` (new), `engineCallLlmAvoidingRepeat`'s extended signature
(now also takes `allowedLinks`), its 3 ecom call sites (product-enquiry route, ecom_faq route —
WhatsApp and Instagram), plus a new general "only state a fact literally in the catalog" instruction
in `engineBuildFaqSystemPrompt`'s ecommerce branch (`cloudflare-worker/worker.js`)
**Broke:** A customer picked a pack size from a real, catalog-driven quick-reply list, then the bot
replied "You can order them directly from our Shopify store here:
https://thevirtues.in/collections/glutathione-collection" — a fully invented, plausible-looking URL.
`engineBuildFaqSystemPrompt`'s ecommerce branch already had an explicit "never invent a link"
instruction (added well before this fix) and the product-enquiry prompt already had its own version
too — neither stopped it. Same class of gap as #15: an instruction is a request, not a guarantee.
**Fix:** `engineFindHallucinatedLink(replyText, allowedLinks)` scans a generated reply for any
`https?://` URL and checks it against the specific real links the model was actually handed that
turn (the enquiry/checkout link, the client's catalog order link) — a prefix/suffix match tolerates
trailing slashes/punctuation without requiring byte-exact equality. `engineCallLlmAvoidingRepeat`
now checks this alongside its existing near-duplicate check in the same pass (at most one retry
total, not two stacked ones) and forces a retry with an explicit correction quoting the invented
URL when it fires; if the retry is still bad, a last-resort string-replace strips the fabricated
link rather than ever knowingly sending one a customer could click. Also added a general
"only state a product fact literally in the catalog above" instruction (supply duration, ingredient,
certification, etc.) to both the FAQ ecommerce branch and the product-enquiry prompt, alongside the
link-specific ones — the same hallucination risk isn't unique to URLs.
**Don't revert:** Removing the deterministic check reopens a real, already-observed failure mode
that the softer prompt instructions demonstrably did not prevent on their own, even with those
instructions still in place.
**Tested:** `worker.test.js` → `engineFindHallucinatedLink`, including the exact Wellness Virtue
case as a named test.

---

## Data contracts (frontend ⇄ backend)

Shapes agreed on implicitly between `dashboard.html` (writes) and `worker.js` (reads) — nothing
enforces these stay in sync besides this note and the tests above. Check both sides before changing
either.

- **`CLIENTS.qual_questions`** (JSON string) — array of either a plain string (legacy, always
  required, no choices) or `{text: string, optional: boolean, options: string[]}`. `options` empty
  or absent = free text. See fix #8, #11.
