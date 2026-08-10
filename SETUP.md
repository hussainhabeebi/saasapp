# Leadvyne — self-provisioning setup (option B)

Front-end (login-gated) → onboard workflow → **creates and activates a dedicated bot workflow
per client via the n8n API** → returns the Chatwoot webhook URL. Each client gets a thin wrapper
that calls one shared engine. Fix logic once in the engine; clients never drift.

```
frontend/index.html ──POST──► n8n: onboard.json
                                  │ checks passcode
                                  │ writes clients-table row  (NocoDB master)
                                  │ POST /api/v1/workflows     (creates wrapper)
                                  │ POST .../activate
                                  └ returns webhook_url
wrapper (per client) ── Execute Workflow ──► engine.json (shared logic: text/voice/image)
followup-template.json  → clone per client for scheduled nudges
```

## 1. CLIENTS config table (NocoDB control plane)
One table holding every client's config. Read with your **master** NocoDB token.

| Field | Type |
|---|---|
| client_name | Single line |
| chatwoot_account_id | Single line |
| chatwoot_inbox_id | Single line |
| chatwoot_base | Single line |
| chatwoot_token | Single line |
| chatwoot_extra_accounts | Long text (JSON array, `[{id,label,chatwoot_base,chatwoot_account_id,chatwoot_token}]` — additional Chatwoot accounts linked for quick access only, see "Additional Chatwoot Accounts" below) |
| nocodb_base | Single line |
| leads_table_id | Single line |
| nocodb_token | Single line |
| openrouter_key | Single line |
| model | Single line |
| language | Single line |
| main_prompt | Long text |
| flow_json | Long text |
| followup_count | Number |
| followup_hours | Single line |
| followup_messages | Long text |
| active | Single line |
| quote_template | Long text |
| quote_terms | Long text |
| quote_validity_days | Number |
| quote_logo_url | Long text (base64 data URI of the uploaded logo) |
| quote_footer_address | Long text (business address printed in the footer of every Quotation/Invoice PDF page, including the Agency module's bulk "Send Quotation" PDFs) |
| quote_header_title | Single line (big heading text printed at the top of the Agency module's bulk "Send Quotation" PDF, e.g. "Travel Agency" — falls back to `client_name` if blank) |
| quote_accent_color | Single line (hex color, e.g. `#0D9C93` — overrides the account's theme color for the Agency module's bulk "Send Quotation" PDF; blank uses the theme color) |
| quote_payment_methods | Single line (free text shown in the Payment Method box on the Agency module's bulk "Send Quotation" PDF, e.g. "Bank Transfer, Cash, Card") |
| quote_tax_percent | Number (tax % applied to the Agency module's bulk "Send Quotation" PDF subtotal, shown as its own line above the Grand Total; `0` if unset) |
| quote_number_seq | Number (incrementing counter for the Agency module's bulk "Send Quotation" PDF — last quote number actually sent, e.g. `12` means the next one is `QUO-0013`. Only written on a real send, mirrors `invoice_number_seq`.) |
| itin_number_seq | Number (separate counter for the "Full Itinerary" send format's own PDF — last one actually sent, e.g. `12` means the next one is `ITN-0013`. Kept apart from `quote_number_seq` so sending an itinerary doesn't burn a quote number and vice versa.) |
| invoice_terms | Long text (Invoice mode's own terms text, separate from `quote_terms` since "valid for N days" wording doesn't fit an invoice — falls back to `quote_terms` if blank. See "Quotation moved into Human Deals + Invoice mode" below.) |
| invoice_number_seq | Number (incrementing counter — last invoice number actually sent, e.g. `12` means the next one is `INV-0013`. Only written on a real send, never on a PDF preview, so a preview never burns a number.) |
| waba_id | Single line (WhatsApp Business Account ID — for template list/create, separate from wa_phone_id) |
| prospect_gsheet_url | Single line (last-used Prospects import sheet link, remembered across logins) |
| authentik_email | Single line (email of the Authentik user allowed to log into this client's dashboard) |
| chatwoot_user_id | Single line (Chatwoot user id created by the Channels module — used for the Shopify SSO login link) |
| stripe_customer_id | Single line (created on first checkout) |
| stripe_subscription_id | Single line |
| plan_name | Single line (synced from the subscribed Price's `nickname`) |
| plan_status | Single line (Stripe subscription status: active/trialing/past_due/canceled/…) |
| plan_renews_at | Single line (ISO datetime — current_period_end) |
| plan_message_limit | Number (optional, from the Price's `message_limit` metadata) |
| wa_credits_balance | Number (running balance from WhatsApp-credit add-on purchases) |
| voice_addon_active | Single line ("Yes"/"No") |
| voice_reply_enabled | Single line ("Yes"/"No", default No/opt-in when blank) — Integrations → Voice-to-Voice Reply toggle. The only gate on the voice-to-voice reply feature — not tied to `voice_addon_active`/billing in any way. See "Voice-to-voice replies" below. |
| voice_tts_provider | Single line (blank/`sarvam`/`ai4bharat`, default blank = Auto) — Settings → Voice → 🔧 TTS Provider (testing) dropdown. Overrides which TTS engine `engineTtsWithFallback` (worker.js) and `ttsWithFallback` (backend/recovery.js) use for this client: blank is normal production behavior (Sarvam primary, AI4Bharat standby on failure); `ai4bharat` forces the standby directly; `sarvam` skips the standby. A testing/debug knob, not a production feature — see "Voice-to-voice replies" below. |
| plan_cancel_at_period_end | Single line ("Yes"/"No" — customer canceled from the Portal but keeps access until `plan_renews_at`) |
| company_address | Long text (billing address, pushed to the Stripe Customer for invoices) |
| billing_email | Single line (**required before a Stripe Customer is ever created** — `ensureStripeCustomer` refuses to create one without it; both `handleBillingCheckoutSubscription` and `handleBillingCheckoutAddon` return a 400 telling the customer to set it first, rather than silently falling back to `authentik_email`, since the login address is sometimes a shared/ops account, not who should receive billing mail. Once a `stripe_customer_id` already exists this field can still be edited/updated freely — the "required" check only guards *creating* the Stripe account in the first place) |
| team_emails | Long text (comma-separated additional Authentik emails with full access to this same account — see "Multi-user support" below) |
| team_chatwoot_users | Long text (JSON, `{email: chatwoot_user_id}` — per-teammate Chatwoot Platform user ids, populated by User Management → Create New User — see "Matching Chatwoot agent" below) |
| team_names | Long text (JSON, `{email: name}` — display names for team_emails, populated by User Management → Create New User — see "Agents = Team Members = Users" below; the now-unused `agents` field it replaced was a plain newline-separated name list) |
| business_policies | Long text (JSON, `{refund, delivery, cancellation}` — structured objection-handling policy text, Settings → Trust & Policies — see "Trust Signals & grounded objection-handling" below) |
| kb_entries | Long text (JSON array, `[{id, question, answer, category}]` — structured FAQ entries from the 📚 Knowledge Base page, additive to the freeform `kb_text` blob rather than replacing it. See "Knowledge Base page" below.) |
| external_store_link | Single line text — Settings → Order Link. A client's own Shopify (or any other) storefront URL. Takes priority over the built-in Ecommerce module's own storefront link everywhere an order link is generated; see "Order-intent links" below. |
| appt_enabled | Single line text (`Yes`/`No`) — Settings → Modules. Turns the Appointment Booking module on; adds the Appointments dashboard tab. See "Appointment Booking module" below. |
| appt_table_ids | Long text (JSON, `{services, bookings}` NocoDB table ids) — this client's own per-client Appointment Booking tables, created by `apptSetupTables()`. |
| calcom_webhook_secret | Single line text — Settings → Cal.com Sync. The shared secret used to verify Cal.com's webhook signature (`X-Cal-Signature-256`). |
| fulfilled_addon_events | Long text (comma-separated Checkout Session ids already fulfilled — dedupes add-on delivery if Stripe redelivers a `checkout.session.completed` webhook; capped to the most recent 20) |
| billing_emails_sent | Long text (comma-separated `<event>:<stripe_object_id>` keys — dedupes the trial-ending/receipt/dunning/action-required emails below if Stripe redelivers a webhook; capped to the most recent 20; see "RBI pre-debit notification" below) |
| notification_email | Single line (email address `n8n/notifications.json` sends hot-lead/handover/SLA alerts to) |
| slack_webhook_url | Single line (optional — Slack incoming-webhook URL; `n8n/notifications.json` posts the same hot-lead/handover/SLA alerts here in addition to email, if set) |
| sla_minutes | Number (optional, default 15 — minutes a lead can sit in `human_handover` before `n8n/notifications.json` fires an SLA-breach alert; see "AI sales rep" section below) |
| objection_playbook | Long text (optional — JSON array of `{category, approved_response}`, category one of `price`/`competitor`/`timing`/`trust`; grounds the engine's objection-handling response — falls back to a generic acknowledge-and-propose-next-step strategy if blank or the category isn't covered) |
| cross_sell_rules | Long text (JSON array, `[{trigger, suggestion, message}]` — Settings → 🔄 Cross-Sell & Upsell. `trigger` is comma-separated keywords matched (client-side, substring match) against a lead's conversation or a quote/invoice's line-item names; `suggestion` is the short label shown in the rules list and as an add-on button; `message` is the WhatsApp-ready text inserted into the reply box. Matched by dashboard.html's lead-detail "🔄 Cross-Sell" card, accounting.html's quote/invoice "Suggested add-ons" row, and ecom.html's read-only product-modal hint — all three read this one field; only dashboard.html Settings writes it. `CROSS_SELL_DEFAULTS` in dashboard.html has a starter rule pack per industry, seeded on demand via "Load starter rules for my industry" — never auto-applied.) |
| deal_currency | Single line (default `AED` — seeds `DealCurrency` on newly created leads) |

### LEADS table additions (for the Quotation module's sent log)
Two more columns on the **LEADS** table (not CLIENTS) so sent quotations show up in the
Quotation tab's "Sent Quotations" report:

| Field | Type |
|---|---|
| QuoteSentAt | Single line (ISO datetime) |
| QuoteSentTotal | Single line |

### LEADS table additions (AI sales rep: sentiment, objections, deal forecast, SLA)
More columns on the **LEADS** table, written by `engine.json` and read/edited by `dashboard.html`:

| Field | Type |
|---|---|
| Sentiment | Single line (`Positive`/`Neutral`/`Negative`/`Frustrated` — set from the engine's AI intent+sentiment classification on every inbound message; a `Frustrated` reading force-escalates to human handover regardless of stage) |
| LastObjectionCategory | Single line (`price`/`competitor`/`timing`/`trust` — set whenever the AI classifier detects an objection; drives the objection-handling response, see `objection_playbook` above) |
| InterestedProduct | Single line (free text — the specific brand, product, or category the AI classifier judges this lead has shown interest in, e.g. "Nike Air Max", "2BHK apartment"; same per-message classification call as Sentiment/LastObjectionCategory above, not a lookup against the Ecommerce module's own product/category catalog, so it works identically for every industry. Only overwritten when a message actually points to something specific — a generic "yes"/"ok" reply leaves whatever was last detected in place rather than clearing it) |
| DealValue | Number (manual — the dashboard's only input into deal size; the engine never sets this, since it has no way to know it) |
| DealCurrency | Single line (defaults from the client's `deal_currency` on lead creation; editable per lead) |
| WinProbability | Number, 0-100 (auto-suggested by the engine from stage progress + lead score on every turn; stops auto-updating once `WinProbabilityManual` is set to "Yes" so a rep's manual call is never silently overwritten) |
| WinProbabilityManual | Single line ("Yes"/"No" — set by the dashboard when a rep manually edits `WinProbability`) |
| HandoverAt | Single line (ISO datetime — stamped the moment a lead first enters `human_handover`; powers the SLA-breach alert and an in-dashboard "waiting Xm" badge) |
| SlaAlerted | Single line ("Yes"/"No" — dedupe flag so `n8n/notifications.json` only fires one SLA-breach alert per handover, reset by the engine each time a lead re-enters `human_handover`) |
| HandoverOutcome | Single line (`Resolved-Won`/`Released`/`Lost`/`No-response`/`Spam` — set only when a rep resolves a lead on the Human Deals page, via the card's ✅ Won/🚫 Spam buttons or the ✕ close-icon modal, `applyHumanDealOutcome()` in `dashboard.html`. Nothing else writes this; a lead handed over before this feature existed simply has it blank. Drives the Human Deals Stage transition (`HD_OUTCOME_STAGE`: Won→`won`, Spam→`lost`, everything else→`new`/`lost`) and the Team page's Funnel Analytics "Handover Win Rate" stat (Spam excluded from that stat's denominator) — see "Human Deals page" below.) |
| ClosedAt | Single line (ISO datetime — stamped once, client-side, by `reportLeadQualityChange()` in `dashboard.html` the first time a lead's Stage reaches a won or lost outcome. Powers the Team page's Revenue Forecast section — see "Revenue Forecast dashboard" below. Also read by the Review Request module (see below) as its "when did this actually finish" signal. Add this column before using either section; leads that closed before the column existed simply have it blank and both features fall back to `Date` for them.) |
| CompanyDomain | Single line (set by `dashboard.html`'s `saveLead()` from a lead's Email domain, when the domain isn't a free personal-email provider — see "Data enrichment on capture" below. Never set by the engine, which has no Email input from WhatsApp.) |
| CompanyName | Single line (a title-cased guess from `CompanyDomain`, set alongside it. Editable — a rep's own correction is never overwritten by re-saving the same email.) |

**Known limitation**: SLA tracking only knows a lead *entered* `human_handover` — the bot stops
writing to the lead entirely once handed over (by design, so it can never talk over a live agent),
so there's no reliable signal in NocoDB for "an agent already replied in Chatwoot." The SLA alert
is therefore a **time-in-stage** proxy (has this lead sat in `human_handover` longer than
`sla_minutes`), not a true first-response-time metric — it clears once the stage changes away from
`human_handover` (e.g. a rep manually moves the lead in the dashboard), not on the agent's first
Chatwoot reply. A tighter version would need to poll Chatwoot's own conversation/message API for an
agent-authored message timestamp, which isn't implemented here.

### Prospects module
Uses existing LEADS columns only — no new schema. Imported contacts are created with
`Stage: "prospect"` and `Tags: "Prospect"`, and get promoted like any other lead once they
reply and progress through your normal pipeline stages.

Requires two things already used elsewhere in this repo:
- `wa_token` / `waba_id` on the CLIENTS row — a Meta System User token with
  `whatsapp_business_management` permission, used **directly from the browser** (same pattern
  as the existing WhatsApp reply feature) to list/create WhatsApp message templates via
  `https://graph.facebook.com/v18.0/{waba_id}/message_templates`. New templates need Meta's
  approval (minutes to a day) before they're usable.
- The same Google Sheets service-account credential already used by the GSheet Sync workflow
  (`REPLACE_GSHEET_CRED`) — the client's prospect sheet must be shared with that service
  account's email, and have `Name` and `Phone` header columns.

Import **n8n/prospects-import.json** (webhook path `leadvyne-prospects-import`) alongside your
other workflows — same NocoDB/Chatwoot credentials as `broadcast.json`. Each webhook call
imports up to 50 new (not-yet-seen) phone numbers from the sheet, creates them as `prospect`
leads, and sends each one the chosen approved template via a freshly created Chatwoot
conversation — so first-touch outbound still goes through the Chatwoot channel, and the
conversation is fully visible in your Chatwoot inbox and linked to the lead from message one.

## 2. Create the n8n API key + credential
1. In n8n: **Settings → n8n API → Create API key**. Copy it.
2. **Credentials → New → Header Auth**, name it **n8n API**, header name `X-N8N-API-KEY`,
   value = the key. (This is the "API I will provide in config".)
   The key lives only here — never in the front-end, never shared.

## 3. Import workflows (in this order)
1. **engine.json** — set the 3 `REPLACE_CONTROL_*` placeholders (clients table) + master NocoDB
   credential. Save. **Copy its workflow id** from the URL.
2. **onboard.json** —
   - `Set · Settings`: `REPLACE_PASSCODE` (your access passcode), `REPLACE_ENGINE_WORKFLOW_ID`
     (the engine id from step 1). n8n_base is already `https://n8n.aiautomationsuae.com`.
   - `NocoDB · Create client`: clients-table ids + master credential.
   - `HTTP · Create workflow` and `HTTP · Activate workflow`: select the **n8n API** credential.
   - Activate the workflow.
3. **followup-template.json** — clone per client for nudges (low volume; per-client is fine).

## 4. Deploy the front-end
It's a static site. On Coolify: new app → this repo → it uses the `Dockerfile` (nginx) to serve
`frontend/`. Or open `frontend/index.html` locally. The onboard endpoint defaults to
`https://n8n.aiautomationsuae.com/webhook/leadvyne-onboard`.

## 5. Use it
Open the page → enter the **passcode** → fill the form → **Provision client**. It writes the
config, creates + activates that client's workflow, and shows the webhook URL. Paste that URL
into the client's Chatwoot inbox (**Configuration → Webhooks**, event **Message created**).

## Security notes
- The passcode is checked server-side in the onboard workflow; the page only collects it.
  For stronger protection, also put Coolify Basic Auth in front of the static site.
- Tokens entered in the form are sent to your onboard webhook over HTTPS and stored in your
  NocoDB. The n8n API key never touches the browser.
- Set the onboard webhook CORS (already `*` in the JSON) to your page origin once it's hosted.

## Dashboard login (Authentik, OIDC)
Login is delegated to a self-hosted Authentik instance instead of the old client-side
`client_name`/`dashboard_password` comparison — that comparison ran entirely in the browser
against a record fetched with a shared token, so any visitor could read every client's row
(passwords, Chatwoot/Meta tokens, everything) via devtools. Authentik replaces that with a
real Authorization Code + PKCE OIDC flow (no client secret — `dashboard.html` is a public SPA
with nowhere safe to store one).

**One-time Authentik setup** (already done for this deploy, keep for reference / new environments):
1. Deploy Authentik via Coolify's one-click service (needs its own Postgres + Redis).
2. Create an **Application** → **OAuth2/OpenID Provider**:
   - Client type: **Public**
   - Redirect URI: the dashboard's own URL (e.g. `https://app.leadvyne.com/dashboard.html`)
   - Authorization flow: `default-provider-authorization-implicit-consent` (skips the "this app
     wants access" consent screen — this is a first-party app, not a third-party integration)
3. Copy the generated **Client ID** into `dashboard.html`'s `CONFIG.AUTHENTIK_BASE` /
   `AUTHENTIK_CLIENT_ID` / `AUTHENTIK_REDIRECT_URI`.

**`authentik/leadvyne-blueprint.yaml`** — turns steps 2 and the Recovery-flow/branding setup
further down into a reviewable, re-appliable file instead of manual admin-UI clicking, for standing
up a second/staging Authentik instance without re-deriving these steps from scratch. Creates the
OAuth2 Provider + Application above, plus a branded "Leadvyne" Brand bound to Authentik's own
built-in Recovery and Enrollment flows (see "Self-service signup" and the Recovery-flow note
below). Deliberately does **not** attempt to author a custom flow with an email-verification stage
from scratch blind — see the file's own header comment for why, and the safe way to add one
(build it once via Authentik's flow-builder UI, export it as a blueprint, merge it in here).
Apply via Authentik Admin UI → Customization → Blueprints → Create, after filling in its
`CHANGE-ME` placeholders (your actual domain, logo/favicon URLs, redirect URI).

**Password reset ("Forgot password?")** — needs a Recovery flow bound to your Brand, same as the
Enrollment flow below; the Blueprint above does this automatically by pointing `flow_recovery` at
Authentik's own built-in `default-recovery-flow`. Without this, a locked-out user (or a new
teammate invited via "Create New User" below) has no self-serve way back in, and every lockout
becomes a support request. Confirm it's bound: Authentik Admin UI → Customization → Brands →
your Brand → check the "Recovery flow" field isn't blank.

**Per-client mapping:**
Authentik only proves *who* logged in (their email); it has no concept of "Leadvyne clients."
After a successful login, the **Worker proxy** (see below — not the browser, since the browser
no longer has a way to query NocoDB directly) looks up the CLIENTS row whose `authentik_email`
field matches Authentik's verified email.

**Self-service signup (customer creates their own Authentik account, no admin step):**
The gate screen is a single **"Continue with Authentik"** button — the same flow serves both
login and signup, because Authentik's own hosted page offers a "Sign up" option once an
enrollment flow is linked to it. This requires one more piece of Authentik configuration
beyond the Application/Provider setup above:

1. **Flows & Stages → Stages** → find the **Identification stage** used by your login flow
   (`default-authentication-identification` or similar) → edit it → set **Enrollment flow**
   to Authentik's built-in `default-enrollment-flow` (or a custom one you've built). This is
   what makes a "Sign up" link appear on Authentik's login page.
2. That's it on the Authentik side — a new user can now click "Sign up" there, set an email/
   password, and get redirected back to `dashboard.html`.

**What happens on first login for a brand-new signup — fully automatic, no form:**
The Worker's `/session/exchange` won't find a matching CLIENTS row (nobody's created one yet) —
instead of a dead-end error, it returns `{error:'no_account', email, access_token}` and
`dashboard.html` calls a single Worker route, `POST /session/auto-provision`
(`handleAutoProvision` in `worker.js`), with just that same access token.

This route is the authoritative account creator — it independently re-verifies the token against
Authentik's own `/userinfo` (the request body's email is never trusted), checks for an existing
CLIENTS row first (`getClientByAuthentikEmail`) so a retried/double-clicked request can never
create a duplicate account, creates the row directly via NocoDB if none exists (business name
guessed from the email's local part, e.g. `jane.doe@x.com` → "Jane Doe", `industry:'general'`),
and returns a session token in the same response — one round trip instead of the old
"call an external webhook, then separately retry `/session/exchange` and hope" dance.

For a brand-new signup specifically, the Worker *also* calls the same external onboarding webhook
(`https://apps.leadvyne.com/webhook/leadvyne-onboard`) server-side afterward, bounded by an 8s
timeout (`fetchWithTimeout`) — this used to be the only thing that created the account at all, and
its exact contents beyond "creates the CLIENTS row" aren't visible from this repo (it's an n8n
workflow, not code here), so it stays wired in as a safety net until that's confirmed unnecessary
for every client. Its passcode is now a Worker secret, **`ONBOARD_WEBHOOK_PASSCODE`** (`wrangler
secret put ONBOARD_WEBHOOK_PASSCODE`) — previously a literal string shipped in `dashboard.html`'s
own source, readable by anyone via devtools.

**Welcome Setup modal** — right after `showApp()` for a brand-new signup specifically (flagged via
`session.isFreshSignup`, set in `autoProvisionAndLogin` and carried through the popup→opener
`postMessage` relay since that spreads every property of `session`), `openWelcomeSetupModal()`
shows a small, no-skip modal asking for the real Business Name and Industry before the rep ever
sees the dashboard. This replaces what used to be a silent `industry:'general'` default —
since Stage tags, theme colour, and terminology throughout the whole app are industry-driven
(`INDUSTRIES` in `dashboard.html`), a client's very first look at their dashboard previously often
didn't match their business at all. `saveWelcomeSetup()` shares the exact same
industry-change/module-auto-enable logic as the existing Settings → Business Setup card
(factored out into `applyIndustryChange(ind, extraPatch)`, used by both `saveIndustry()` and this
modal) plus writes `client_name`. No skip/close button by design — a returning user never sees
this again since it only fires on the fresh-signup path, and both fields are quick, low-friction
asks. (The modal can still be dismissed by clicking the shared `#overlay` backdrop, same as every
other modal — this is a soft nudge, not a hard gate; a dismissed new account just falls back to the
pre-existing "General" default and can fill both fields in later from the Getting Started checklist
or Settings, same as before this existed.)

Chatwoot isn't connected yet at this point (Authentik has no way to collect that). The new
client fills it in themselves from **Settings → Chatwoot Webhook**, which now has all four
fields (`chatwoot_base`, `chatwoot_account_id`, `chatwoot_inbox_id`, `chatwoot_token`) —
previously only the base URL was editable there, everything else was signup-wizard-only. The
Home page's **Getting Started checklist** (`renderOnboardingChecklist()`) already nudges toward
this ("Connect a channel") — it also has an "Invite your team" step (checks
`team_emails` for at least one entry, links to Settings → User Management,
`id="userMgmtCard"` for the same pulse-highlight `bizSetupCard` already used).

**Session persistence** — `lv_cid`/`lv_session`/`lv_me_email` moved from `sessionStorage` to
`localStorage` (`dashboard.html`). This was the real cause of "have to log in constantly" reports
from mobile/WhatsApp-heavy reps — closing a tab or backgrounding a mobile browser/PWA wipes
`sessionStorage` entirely regardless of the session token's own expiry, forcing a fresh Authentik
round-trip far more often than the token TTL alone ever would. `SESSION_TTL_SECONDS` (`worker.js`)
also moved from 24h to 30 days, and `GET /session/me` (called by `resumeSession()` on every app
load) now reissues a fresh, full-length token on every successful call — a sliding window, so an
account opened at least once a month never actually reaches the expiry ceiling. Logging out
(`hLogout`) still clears all three keys immediately, same as before. **Tradeoff, stated plainly**:
these are stateless HMAC tokens with no server-side revocation list, so a longer TTL means a
compromised token stays valid longer too — a deliberate choice favoring day-to-day convenience for
an internal sales tool over that risk; add a revocation/deny-list if this ever needs tightening.

**Follow-on fix**: `broadcast.html` and `email-marketing.html` (both opened via `window.open()`
from `dashboard.html`, relying on reading the same storage rather than being passed a token — see
each file's own "AUTH" comment) still read `lv_cid`/`lv_session` from `sessionStorage`, which
`dashboard.html` no longer writes to at all after the above change — broken immediately by this
migration until caught and fixed to read `localStorage` too (same-origin `window.open` makes
`localStorage` directly readable with no sharing/copying step needed, unlike `sessionStorage`,
which relies on the browser cloning it into the new tab). Any *other* page opened the same way
(`window.open('somepage.html', ...)` from `dashboard.html`, not an iframe with the token passed via
query string) needs the same check.

**Passwordless / social login (Google, magic link, etc.)** is entirely an **Authentik-side
configuration change, not app code** — `dashboard.html`'s login button already just opens
Authentik's own hosted flow in a popup, so whatever authentication methods that flow is configured
to offer (a **Source** for Google/social OAuth, or a passwordless **Email** stage) show up there
automatically with zero changes needed here. Not built in this pass since it requires an admin
decision + configuration in the Authentik instance itself, outside this repository.

Admin-created clients (the old path — create the CLIENTS row yourself, then create their
Authentik user manually and set `authentik_email`) still works fine alongside this; both paths
converge on the same `authentik_email` matching logic.

**Multi-user support (team_emails):** one CLIENTS row is still one tenant/account, but more than
one Authentik login can access it. `getClientByAuthentikEmail` in the Worker first tries an exact
`authentik_email` match (the primary owner); if that misses, it falls back to `team_emails` — a
plain comma-separated list on the same CLIENTS row — matched exactly (case-insensitive) in code
rather than trusting NocoDB's `LIKE` alone, since a naive substring match could false-positive on
similar addresses. **Settings → User Management** has two ways to add a teammate: "Add Existing
Authentik User" just appends an email to `team_emails` (they must already have — or self-serve
create — an Authentik account); "Create New User" (see below) provisions the Authentik account
itself, no separate step required. Either way, the moment that email signs in via Authentik they
land straight in the same dashboard with full access — same as the owner, no role restrictions,
no seat limit. If you want restricted roles or plan-tied seat limits later, that logic would live
in this same matching function plus per-action permission checks in the UI.

**Additional Chatwoot Accounts (Settings → Channels):** a client-owned CRM can only ever have one
*primary* Chatwoot account (`chatwoot_base`/`chatwoot_account_id`/`chatwoot_token`/
`chatwoot_inbox_id` — the one the Chats tab, AI bot, Quotation sending and Prospects all read).
`chatwoot_extra_accounts` is a separate, unwired JSON array for linking *other* Chatwoot accounts
the client already owns elsewhere (a second brand, another store) as a quick-access directory
only — same "just another field, saved via `patchClient()`" pattern as `team_emails`, no new
Worker route. "Open" just navigates to `{base}/app/accounts/{id}/dashboard` in a new tab; there's
no SSO into these the way there is for the primary account (`handleChannelsChatwootSso`), since
this Worker's `CHATWOOT_PLATFORM_TOKEN` only reaches accounts it created itself — an externally
owned account needs its own normal Chatwoot login.

**Creating users directly (User Management → Create New User):** `POST /team/create-user`
(session-gated, takes only `name`/`username`/`email` — no password field anymore) calls Authentik's
own Core API — `POST /api/v3/core/users/` to create the account (`username`/`email`/`name`/
`is_active`), then `POST /api/v3/core/users/{id}/set_password/` with a server-generated random
password (`generateRandomPassword()`) using a service-account API token, `AUTHENTIK_API_TOKEN` (a
new Worker secret, see "Deploy" below). If `set_password` fails after the user was created, the
Worker best-effort deletes the just-created user rather than leaving a passwordless, unreachable
account behind.

**Invite link, not an admin-chosen password:** immediately after, the Worker calls
`POST /api/v3/core/users/{id}/recovery/` to generate a one-time recovery link for the new user, and
emails it (`sendTeamInviteEmail`, platform-level `RESEND_API_KEY`, same "own From address" pattern
as `sendBillingEmail`) so the teammate sets their **own** password instead of the admin picking one
on their behalf and relaying it. The link is also returned in the response and shown in the UI
regardless of whether the email send could be confirmed, so it can be shared directly (WhatsApp,
Slack) if email delivery isn't set up. This needs a Recovery flow bound on the Authentik instance
(see the Blueprint note above) — if that call fails (not configured yet), the response falls back
to the random password generated above instead (`fallbackPassword`), shown once in the UI exactly
like the old flow; team creation is never blocked either way. On success, the frontend appends the
new email to `team_emails` the same way the existing "add by email" flow already does — no separate
Worker-side write, reusing `patchClient()`.
**Authentik token permissions needed**: `authentik_core.add_user`, `authentik_core.reset_user_password`,
and now also the ability to create recovery links for a user (a superuser token covers all three —
simplest for a self-hosted single-tenant Authentik instance where this Worker is the only caller of
the Admin API). Create it under **Directory → Tokens** (or a dedicated service account) in Authentik.

**Matching Chatwoot agent (same request, best-effort):** if the client already has Chatwoot
connected (`chatwoot_account_id` set — see "Channels module"), `handleTeamCreateUser` also calls
`createChatwootAgent()`, which reuses `chatwootPlatformFetch` (the same Platform API helper
`handleChannelsCreateAccount`/`handleChannelsChatwootSso` already use) to: create a Chatwoot
Platform user with the *same* name/email and the server-generated random password (Chatwoot has no
invite-link concept of its own, unlike the Authentik side above), link them to the client's
existing account via `POST /platform/api/v1/accounts/{id}/account_users` with `role:'agent'` (not
`'administrator'` — that role is reserved for the account owner's own Chatwoot user), and generate
a one-time SSO login link via `POST /platform/api/v1/users/{id}/login`. None of this can fail the
overall `/team/create-user` request — Chatwoot may not be connected yet, or the email may already
exist as a Chatwoot Platform user; either way the Authentik/dashboard account is still created and
the response just carries `chatwoot:{ok:false, error}` instead. On success the frontend shows
`chatwootPassword` (Chatwoot-specific, separate from the Authentik invite link above) plus two
links: the one-time "Log in to Chatwoot now" SSO link, and a durable direct link to the connected
inbox (`{chatwoot_base}/app/accounts/{account_id}/inbox/{inbox_id}`) for viewing conversation detail.

**`team_chatwoot_users`** (Long text, JSON — new Clients field, e.g. `{"jane@x.com":42}`): the
one-time SSO link shown at creation time is single-use, so `handleTeamCreateUser` also persists
`{email: chatwoot_user_id}` here on success. That's what powers the always-available "Log in to
Chatwoot ↗" link at the top of the Chats tab sidebar (`dashboard.html`'s `openChatwootSso()`) —
it calls `GET /channels/chatwoot-sso?email=<myEmail>` (the caller's own verified email,
`dashboard.html`'s `myEmail`, set at login), and `handleChannelsChatwootSso` looks up that
specific person's Chatwoot user id here (falling back to the account owner's `chatwoot_user_id`
if the email matches the owner, or if no per-user agent was ever created for them — e.g. they
were added via "Add Existing Authentik User" instead of "Create New User") before minting a fresh
one-time login link. Each click always mints a new link — none are stored or reused.

**Accounts connected the older, manual way have no `chatwoot_user_id` at all** (Settings →
Channels' base/account/inbox/token paste-in fields — a fully working connection, chats and sends
run fine off `chatwoot_token` alone, it just never went through `handleChannelsCreateAccount`'s
Platform API call that would have set `chatwoot_user_id`). `handleChannelsChatwootSso` checks
real connection state (`chatwoot_account_id`/`chatwoot_base` present) separately from SSO
capability (`chatwoot_user_id` present) — a connected-but-no-user-id account gets a direct,
not-pre-authenticated link to the Chatwoot dashboard (`{ok:true, sso:false, url}`) instead of the
misleading "Connect a Chatwoot account first" error it used to return. Only a client with neither
field set is treated as genuinely not connected.

**Agents = Team Members = Users (`getTeamMembers()`, `dashboard.html`):** leads had a separate,
disconnected "Owner" concept — a free-text name list on a now-removed `agents` Clients field
(Settings had its own "Agents" textarea, `cfgAgents`), matching nothing else in the app. That's
gone; `getTeamMembers()` is now the single source for "who can be assigned things" — the account
owner plus everyone in `team_emails`, each `{email, name}` (name from the new `team_names` field,
`{email: name}`, populated automatically by User Management → Create New User; falls back to the
bare email for teammates added via "Add Existing Authentik User", which never collects a name).
Every dropdown that used to read `getAgents()` (Lead Owner in the Add/Edit modal and detail pane,
Recruitment candidate owner) now reads `getTeamMembers()` instead, and both **Lead.Owner** and
**Task.assignee_email** store the same value — an email — so the two can finally be joined for
reporting (see "Team Performance" below). `teamMemberOptions(currentValue)` renders the `<option>`
list and, if `currentValue` doesn't match any current team member (an Owner set before this
unification, or a since-removed teammate), still appends it as a selected-but-unlisted option
rather than silently blanking the field on next save.

**Team Performance (📊 Team nav tab, `renderTeamPerformance()`):** a per-agent report — leads
assigned/active/won, win rate, hot leads, total won deal value (`DealValue`, summed), tasks
assigned/done/overdue, task completion rate — computed entirely client-side from `allLeads` and
the existing tasks state (`getTasksState()`), joined against `getTeamMembers()`'s email list. No
new backend route; it's a straight filter/group over data the dashboard already loads.

**Push Lead to Task (lead detail pane → "📌 Push to Task"):** calls the existing task modal
(`openTaskModal(null, currentLead)`, a new second `prefillLead` parameter) pre-filled from the
lead — title, due date (its `ReminderDate` if set, else today), lead link, and assignee (its
`Owner`) all default from it but stay freely editable before saving, same modal/flow as any other
task. Home's "Follow-ups" widget (`renderHomeFollowUps`) now merges lead `ReminderDate` items
*and* manual tasks due today/overdue (both come from the same `computeAllTasks()` the Tasks page
itself renders from), so a pushed task shows up on Home immediately, not only on the Tasks page.

**Trust Signals & grounded objection-handling:** the actual conversational WhatsApp bot (the one
that replies to customers in real time) is **not part of this repo** — it runs entirely in an
external n8n workflow (`engine.json`, plus the per-client wrapper `onboard.json` provisions;
see "Thin API proxy" below and the top of this file). `main_prompt`/`kb_text`/`followup_count`
etc. are just CLIENTS fields that workflow reads directly from NocoDB — `dashboard.html` and
`worker.js` only ever write them, never build a bot reply themselves. So "make the bot answer
refund/delivery/cancellation objections itself, mid-conversation" isn't something this repo can
deliver end-to-end; that last mile is an n8n-side change, outside this codebase.

What *is* fully built here, in the dashboard the sales rep actually uses:
- **Settings → Trust & Policies** (`dashboard.html`) — three structured fields (Refund, Delivery,
  Cancellation), stored as `business_policies` (JSON) on the Clients row, separate from the
  freeform `kb_text` blob so there's a specific field to point at instead of a big pasted
  document. Loaded/saved via `getBusinessPolicies()`/`$id('savePolicies')`'s click handler,
  same `saveField()`/`patchClient()` pattern as every other Settings field.
- **AI Deal Coach** (`generateDealCoach()`, lead detail pane) — its prompt to `/ai/complete` now
  includes `getBusinessPolicies()`'s text and `getRecentBookingsCount()` (leads that reached a
  booked/won `TERMINAL` stage in the last 7 days, using `Date` as a proxy for conversion time —
  there's no dedicated stage-change timestamp tracked yet), with an explicit system-prompt
  instruction to answer objections from the real policy text and cite the real booking count
  instead of generic advice ("offer a quick call").
- **Trust Signals widget** (same pane, "📣 Trust Signals" button, `renderTrustSignals()`) — a
  non-AI, zero-hallucination list of ready-to-send snippets (the recent-bookings count, the
  `review_link`, and each policy that's filled in), each with an "Insert" button that appends it
  straight into the reply box (`#waReplyText`) so a rep can drop a real trust signal into a chat
  with one click instead of typing it out.
- **`business_policies` is already available to the external n8n bot**, the same way `main_prompt`/
  `kb_text` are — it's just another field on the CLIENTS row that workflow already reads from
  NocoDB directly. Wiring it into the bot's own system prompt (so it can answer these objections
  live, not just the dashboard) is the n8n-side follow-up this repo can't do on its own.
- **`POST /ai/objection-reply`** (`cloudflare-worker/worker.js`, `handleAiObjectionReply`) closes
  that follow-up from the Cloudflare side, without touching the rest of n8n's conversation flow.
  Client_id-based like `/ecom/order-link` above (no session — n8n has none). Body:
  `{client_id, message}`. Screens the one incoming message against this client's
  `business_policies`/`review_link` via OpenRouter (`c.openrouter_key`/`c.model`, same fields
  `/ai/complete` uses) and returns either `{handled:false}` (not an objection/trust question —
  n8n's own flow proceeds exactly as it does today) or `{handled:true, reply:"..."}` (a reply
  grounded in the real policy text, ready for n8n to send). **Deliberately n8n-called, not an
  independent Chatwoot webhook listener** — n8n stays the single point of truth for what actually
  gets sent to the customer, so there's no risk of two systems replying to the same message. The
  one remaining step is on the n8n side: add one HTTP Request node calling this endpoint at the
  point where the engine decides how to respond, and send its `reply` when `handled:true` instead
  of (or before) its own default response for that turn.

**Order-intent links (ecom/physical products):** same repo-boundary as above — *detecting* order
intent mid-conversation is the external bot's job, not something built here. What this repo does
provide is the automation surface that detection should call, plus a rep-facing manual version of
the same thing:
- **`POST /ecom/order-link`** (`cloudflare-worker/worker.js`, `handleEcomOrderLink`) — the
  automation entry point, client_id-based like the rest of `/ecom/*` (no Authentik session, since
  n8n has none). Body: `{client_id, phone, name?, sku?}`. Builds the order link via the shared
  `buildOrderLink(c, clientId, sku)` helper (see below), sends it directly via Meta's Graph API
  (bypassing Chatwoot, same pattern as `handleWaSend`), and **always** logs a `pending`-status row
  in the client's ecom orders table — even if the WhatsApp send itself fails (e.g. the customer is
  outside Meta's 24h free-form-message window), so "order intent" leaves a paper trail regardless.
  Returns `{ok, link, order_id, whatsapp_sent, whatsapp_error?}`. This is the route the n8n bot
  should call the moment it decides a customer wants to buy something.
- **Dashboard version** (`dashboard.html`, lead detail pane → "🛒 Push to Order") — same modal
  that already created ecom order rows now also has a product picker
  (`loadPoProducts()`/`#poProduct`, populated from `GET /ecom/products`) and a "📲 Also send this
  order link via WhatsApp right now" checkbox (`updatePoLinkPreview()`/`buildStorefrontLink()`,
  editable message preview, sent via the session-authed `POST /wa/send` — a different route from
  `/ecom/order-link` above since this call already has a dashboard session). Same
  send-can-fail-without-blocking-the-order-row behavior as the automation route. `poStatus` picked
  up a `pending` option (matching `ORDER_STATUS_OPTIONS` in `ecom.html`, which already had it —
  this dropdown was just missing it) and now defaults to it, since a just-sent link is order
  intent, not a confirmed order.

**External stores (Shopify or anything else) as the order link, Settings → 🔗 Order Link:** most
clients don't actually sell through the built-in Ecommerce module — they already run a Shopify
store (or something else) and just want the CRM/bot pointing customers at *that*. `external_store_link`
(new CLIENTS field, plain text, e.g. a `https://yourstore.myshopify.com` URL) is a manual override
clients set once; every order-link code path checks it first and only falls back to the built-in
module's own `onshope.com/<slug>` / `store.html?client=<id>` link when it's blank:
- `buildOrderLink(c, clientId, sku)` (`worker.js`) — the one place `handleEcomOrderLink` builds a
  link, so the automation route picks this up automatically.
- `buildStorefrontLink(sku)` (`dashboard.html`) — same fallback, used by "Push to Order"'s link
  preview and, through it, everywhere else in the dashboard that shares a store link.
- `buildKbProcessorText()`'s `## ORDER LINK` guidance (see "Zero-n8n-edit alternative" above) now
  fires whenever *either* `external_store_link` is set *or* the client has ecom module tables
  configured — previously it only fired for the built-in module, so a Shopify-only client's bot
  never got told to share a link at all.
- `handleChatwootMessageHook`'s auto order-tracking (see "Closing the loop on order-row creation"
  below) resolves the client first now (previously it checked the link pattern before knowing which
  client sent it), then matches either the built-in `onshope.com/store.html` pattern *or* a plain
  substring match against that client's own `external_store_link` — an arbitrary external domain
  has no known query-param scheme to extract a `sku` from, so sku goes unset (still logs the order,
  just without a specific product attached) when the match comes from an external link.
- Note this is a manual field, not a live read of the connected `shopify_shop_domain` — a client
  who's connected Shopify via Settings → Integrations for order-notification webhooks still needs
  to separately paste their store URL here if they want it used as the *order link* too; the two
  aren't wired together.

**Non-ecom industries (healthcare/services/consultancy/etc) — booking, not ordering:** every
industry but Ecommerce (`INDUSTRIES` in `dashboard.html`) already converts leads via a *booking*
(appointment, consultation, viewing, test drive, placement — `TERMINAL` already has
`appt_booked`/`consultation_booked`/`visit_booked`), not a purchase, so there's no ecom order row
to create. Settings → Order Link relabels itself "🔗 Booking Link" for these clients
(`isBookingIndustry()`, `dashboard.html` — true for any industry except `ecommerce`) and
`external_store_link` holds a scheduling URL (Calendly/Cal.com/etc) instead of a storefront.
- **`POST /leads/booking-link`** (`worker.js`, `handleLeadBookingLink`) — the booking equivalent of
  `/ecom/order-link`, same client_id-based/no-session shape for n8n to call. Body:
  `{client_id, phone, name?}`. Sends the configured booking link over WhatsApp directly, then calls
  the shared `advanceLeadBookingAndTask()` helper: finds the lead by phone, advances its `Stage` to
  whichever of `appt_booked`/`consultation_booked`/`visit_booked` actually exists in that client's
  own `flow_json` (never writes a stage the client hasn't defined in their stage builder — if none
  of the three are present, the stage is left alone), and appends a follow-up task to
  `manual_tasks` (the same JSON-on-CLIENTS field the Tasks page itself reads/writes — no new
  table). Returns `{ok, link, whatsapp_sent, lead_id, stage_advanced}`.
- **The zero-n8n auto-tracking webhook covers this too**: `handleChatwootMessageHook` (see "Closing
  the loop" above) now branches on whether the client has an ecom orders table configured. If not
  — i.e. a pure booking-industry client — it calls the same `advanceLeadBookingAndTask()` helper
  instead of logging an ecom order, deduping on "lead already at a booking-terminal stage" rather
  than a pending-order check. So a healthcare client gets the exact same zero-n8n-edit automation
  ecom clients get, just pointed at the lead pipeline instead of an orders table.
- No dashboard button calls `/leads/booking-link` directly, same as `/ai/order-signal` and
  `/ai/objection-reply` — it's meant to be called from n8n once a booking signal is detected there,
  the same n8n-calls-Cloudflare pattern as those two.

**`POST /ai/order-signal`** (`handleAiOrderSignal`) — decides *whether* and *for what* to call
`/ecom/order-link` above; it never sends anything itself. Same n8n-calls-Cloudflare shape as
`/ai/objection-reply`: client_id-based, no session. Body: `{client_id, message}`. A "signal" isn't
only an explicit "I want to buy X" — a specific-variant question (size, color, stock, price of one
item — `PRODUCT_FIELDS` in `ecom.html` already has `color`/`size` columns) is just as strong a
buying signal for physical goods, so those count too; the prompt is built with the client's product
catalog (`name`/`sku`/`color`/`size`/`category`, up to 100 rows) so the model can attempt to match
the message to one specific product. Returns `{signal:false}`, `{signal:true}` (order-ready but no
confident product match — push the general catalog link), or `{signal:true, sku:"..."}` (push that
product's link specifically). n8n should call this on order-relevant messages, then call
`POST /ecom/order-link` with the resulting `sku` (if any) when `signal:true`.

**`GET /ecom/order-lookup?client_id=<id>&phone=<phone>`** (`handleEcomOrderLookup`) — plain lookup,
no AI: does this phone number have prior orders, and what's their status (up to 5, most recent
first)? So a returning customer ("where's my order?", "I already paid") gets recognized instead of
the bot starting a fresh sales pitch or `/ai/order-signal` pushing a second, redundant order link.
Cheap enough to call on every incoming message; n8n decides what to do with the result (reference
the existing order in its reply, skip re-pushing a link, etc.) — this repo only surfaces the data,
same repo-boundary as everything else in this section.

**Zero-n8n-edit alternative — controlling the bot purely through KB content:** the four routes
above (`/ai/objection-reply`, `/ai/order-signal`, `/ecom/order-link`, `/ecom/order-lookup`) need at
least one new HTTP Request node added to the n8n workflow each — real automation, but it does mean
touching n8n. If that's not wanted yet, policy-grounding and "mention the order link" behavior can
land with **no n8n node changes at all**, because the bot already reads `kb_text`'s AI-processed
summary as grounding context every turn, and this repo already owns the one webhook call
(`leadvyne-kb-process`) that feeds `kb_text` into that summary. `buildKbProcessorText()`
(`dashboard.html`) appends a `## STORE POLICIES` block (from `business_policies`), a
`## SOCIAL PROOF` line (`getRecentBookingsCount()`), and — if the client has any ecom tables
configured (`getEcomTableIds()`) — a `## ORDER LINK` instruction block with the static storefront
link and guidance on when to share it, onto the raw `kb_text` before POSTing to
`/webhook/leadvyne-kb-process`. Both call sites (`$id('saveKb')`'s click handler and
`triggerKbRefresh()`, fired whenever policies/KB text change) send this enriched text as the
webhook's `kb_text` payload field — **the stored `kb_text` field itself, what a rep sees in
Settings, is never rewritten**, only what's sent to the processor is enriched. Net effect: without
touching engine.json, the bot's own grounding context gains real policy wording, a live booking
count, and a standing instruction to surface the order link on buying signals — no per-message
Cloudflare round trip required. The honest limits of this path: (1) it depends on the n8n workflow
actually feeding `kb_text`'s processed summary into the live prompt every turn — true for the setup
this repo was built against, but unverified here since engine.json isn't in this repo; (2) the
order link this path teaches the bot to *say* is the generic client-wide storefront link, not a
per-conversation trackable one.

**Closing the loop on order-row creation too, still with zero n8n edits:** `/ecom/order-link`
gets called by n8n on-purpose; `/hooks/chatwoot-message` gets there a different way — it watches
for the *effect* of the KB-injected instruction instead of n8n calling anything.
- **`POST /ecom/enable-order-tracking`** (session-authed, dashboard **Settings → Auto
  Order-Tracking** button) registers a **second, independent Chatwoot webhook** on the client's
  WhatsApp inbox — same `POST .../accounts/:id/webhooks` call Chatwoot already gets one of during
  WhatsApp connect (that first one feeds `c.webhook_url`, i.e. n8n's own inbound webhook — see the
  "Best-effort" registration in the WhatsApp-connect flow). Chatwoot supports multiple webhooks per
  inbox and fires all of them on every event, so adding this one doesn't touch, replace, or even
  need to know about the one already pointed at n8n. One click, no manual Chatwoot dashboard visit
  needed either — it's registered via the Chatwoot API from this repo.
- **`POST /hooks/chatwoot-message`** (`handleChatwootMessageHook`) is what that second webhook
  points at. It receives every `message_created` event on the inbox and does exactly one thing:
  if the message is **outgoing** (the bot's own reply) and its text contains the storefront link
  pattern (`onshope.com/<slug>` or `store.html?client=<id>`, same regex either KB-injected
  instructions or `/ecom/order-link` would produce), it resolves the client from
  `chatwoot_account_id`, pulls the customer's phone off the conversation payload, and logs a
  `pending` order row — same shape `/ecom/order-link` creates, `notes` marked
  "auto-logged, no n8n changes". Deduped per phone (skips if a pending auto-logged order already
  exists) so a bot repeating the link mid-conversation doesn't spam rows. **It never sends
  anything to the customer** — only a silent DB write — which is exactly why this is safe to run
  independently of n8n: there's no second reply that could race or duplicate the bot's own
  message, the coordination risk that made `/ai/objection-reply` and `/ai/order-signal`
  deliberately n8n-called instead. n8n's workflow doesn't know this webhook exists and needs no
  changes for it to work.
- **Honest limits:** this only fires when the bot's reply actually contains the literal link text
  — it depends on the model reliably following the KB-injected instruction to include it verbatim,
  same instruction-following caveat as the policy-grounding path above, not a guarantee the way a
  real n8n → `/ecom/order-link` tool call would be. The Chatwoot webhook payload shape used here
  (`message_type`, `content`, `account.id`, `conversation.meta.sender.phone_number` /
  `conversation.contact_inbox.source_id`) is based on Chatwoot's documented `message_created`
  event and defensively parsed, but hasn't been verified against a live payload from this specific
  Chatwoot instance/version — if phone or account resolution comes back empty in practice, that's
  the first place to check. And this endpoint has no request-signing/auth check (Chatwoot webhooks
  aren't authenticated by default here), same accepted client_id-based-trust tradeoff as the rest
  of `/ecom/*` — it only ever performs a `pending`-status insert, never a destructive action, which
  keeps the blast radius of a spoofed call low.

**Booking-industry clients get more than the passive watch above — a direct, Cloudflare-only
auto-send.** The outgoing-message watch relied on the bot actually including the booking link in
its own reply (best-effort, LLM instruction-following). `handleChatwootIncomingBookingSignal`
(same file, called from `handleChatwootMessageHook` for `message_type==='incoming'`) closes that
gap for services businesses: it screens the *customer's own* message with AI
(`detectBookingSignal()`, shared with `/ai/booking-signal`) and, if it reads as booking-ready,
**sends the booking link itself over WhatsApp right there** — no waiting on the bot, no n8n call.
- Scoped to booking-industry clients only (`external_store_link` set, no ecom orders table —
  ecom clients keep the passive-only behavior above) with WhatsApp and an OpenRouter key
  configured. Skips a lead already at a booking-terminal stage, and dedupes on "this phone already
  has a `requested` appointment" (once the Appointment module is set up) before spending an AI call
  — so it fires once per lead's pre-booking window, not on every message.
- **This is the one deliberate exception to "never sends anything to the customer" in this whole
  section** — every other zero-n8n mechanism here (policy grounding, the outgoing-message watch)
  was designed specifically to avoid double-reply risk by never generating a customer-facing
  message on its own. This one does, because there's no other way to make "order intent found →
  booking link sent" actually automatic without either an n8n workflow edit or a real risk: **if
  the client's n8n bot also replies to that same incoming message with its own text, the customer
  gets two messages.** Settings → Auto Order-Tracking's copy (`dashboard.html`) says this plainly
  before a booking-industry client enables it. There's no way to detect from Cloudflare's side
  whether n8n's bot is about to reply too — that visibility gap is inherent to n8n being a black
  box to this repo, not something a smarter check here could close.
- `sendBookingLinkNow()` (`worker.js`) is the actual send-and-log logic, factored out of
  `handleLeadBookingLink` so both the n8n-callable HTTP route and this direct path share one
  implementation instead of two copies that could drift.
- **Routes through Chatwoot, not straight to Meta.** This webhook fires because of a real message
  on a real Chatwoot conversation, so `body.conversation.id` is already known —
  `sendBookingLinkViaChatwoot()` uses it to POST the reply to Chatwoot's own
  `.../conversations/:id/messages` endpoint (same FormData/`content` pattern
  `handleWaReplyChatwoot` already uses) instead of building a Meta Graph API payload by hand.
  Chatwoot's own WhatsApp Cloud API channel (configured with this same `wa_token`/`wa_phone_id`
  during WhatsApp connect) does the actual relay to the customer. Two wins: the message shows up in
  the rep's Chatwoot inbox like any other reply instead of being invisible to Chatwoot entirely, and
  there's no more hand-built `text.body` payload for this path to get wrong. `sendBookingLinkNow()`
  (the direct-Graph-API version) is kept as the fallback for the unlikely case Chatwoot's payload
  omits `conversation.id` or Chatwoot isn't configured, and remains the only path
  `POST /leads/booking-link` uses (no Chatwoot conversation context available there — it's called
  by n8n/a rep with just a phone number, not from inside a live Chatwoot webhook).

**Ecom clients get the same direct auto-send, plus conversation context for resolving bare
replies.** `handleChatwootIncomingOrderSignal` (`worker.js`, same dispatch point — clients *with*
an ecom orders table go here instead of the booking path) mirrors everything above for ecom:
screens the customer's own message with AI (`detectOrderSignal()`, shared with
`/ai/order-signal`), and on a signal sends the order link directly — via `sendOrderLinkViaChatwoot()`
when a Chatwoot `conversation.id` is available (same routing preference as booking), falling back
to `sendOrderLinkNow()` (direct Graph API, also what `POST /ecom/order-link` uses). Same double-
reply-risk tradeoff, same honest limits, same accepted-trust auth model.
- **Built specifically to fix an observed failure**: a real customer replied "Order M size" to a
  product the bot had just shown with sizes S/M/L/XL — and the client's own n8n flow answered "we
  don't have any products currently matching your preferences" instead of recognizing the reply
  as referring to the product it had itself just displayed. A signal like "M size" carries no
  information on its own; it only means something in light of what was just discussed.
- **`fetchRecentChatwootContext(c, conversationId, limit)`** (shared by both the order and
  booking auto-send paths) fetches the last few messages on the Chatwoot conversation
  (`GET .../conversations/:id/messages`) and formats them as plain `Customer: .../Bot: ...` lines,
  passed into `detectOrderSignal()`/`detectBookingSignal()` as `contextText` so the model can
  resolve "M size" or "the 30 min one" back to whichever product/service was actually just shown,
  instead of trying to match a bare phrase against a catalog with no context at all. Assumes
  Chatwoot's messages-list response is oldest-first — the standard REST-list convention, but
  unverified against a live payload from this specific Chatwoot instance/version, same honest
  caveat as the rest of this file's Chatwoot-shape assumptions.
- `/ai/order-signal` and `/ai/booking-signal` (the n8n-callable HTTP endpoints) now also accept an
  optional `body.context` string, for n8n to pass its own recent-conversation text if it has one
  handy — the same underlying gap applies there too; this repo just can't fetch Chatwoot's history
- **The fix above over-corrected**: instructing the model to resolve bare replies against "whichever
  product was just discussed" made it reuse the *previous* product's sku even for a message that
  names its own conflicting detail — observed live: "Green shirt" correctly matched the green linen
  shirt just shown, then "Redshirt" (no such product in the catalog) got the exact same green
  shirt's card sent back, because the prompt didn't distinguish "bare reference, use context" from
  "names its own detail, match fresh." `detectOrderSignal`'s prompt now only falls back to recent
  conversation for messages with no distinguishing detail of their own ("order it", "M size" alone,
  "that one") — a message naming its own color/size/product name is matched against the catalog
  fresh, and if it doesn't match anything, the reply falls back to `resolveOrderProductAndText`'s
  generic "here's our full catalog" text (no sku) instead of reusing an unrelated product.
- **That fix then over-corrected the other way**: telling the model to omit sku unless "confident"
  about a fresh match made it too literal — "Looking for green shirt" and "Greenshirt small size"
  (both genuinely matching the catalog's "Light Green" shirt) started falling back to the generic
  catalog link too, the same failure mode as before, just for legitimate queries this time. The
  prompt now explicitly calls out that customer wording won't match catalog fields exactly
  ("green" vs "Light Green", "greenshirt" vs "green shirt", "S"/"small"/"S size" all the same
  detail) and to match by everyday judgment, not string equality — while keeping the earlier fix's
  actual point: a detail that *conflicts* with the just-discussed product means a new product, not
  a reason to fall back to the generic link.
- **`logPendingOrder` never checked whether its NocoDB write actually succeeded** — same silent-
  failure shape as `ncPatchVerified` was written to fix elsewhere in this file. A rejected/failed
  POST (bad field type, schema-cache lag right after a client's orders table was first configured,
  etc.) still returned a fake `order_id` as if it had landed, so a customer could receive an order
  link over WhatsApp with nothing ever appearing on the Orders page and no error anywhere to explain
  it. Now checks the response and reports failures via `reportOpsError`.
  itself from those endpoints without knowing the conversation id, which n8n would need to supply.

**Both booking links are also just shown on the Appointments tab itself** (`renderApptLinkBar()`,
`dashboard.html`) — a small bar under the sub-nav, visible on every Appointments sub-page, with a
Copy button for each: the external link (`external_store_link` — Cal.com/Calendly/etc, if set) and
this repo's own public booking page (`book.html`, see below — always available once the module's
tables exist). Purely a convenience so a rep can grab either without leaving the tab — e.g. to paste
into `main_prompt` by hand for a client who wants the bot's own base prompt to mention it directly,
on top of (or instead of) the KB-injected guidance above, which now falls back to `book.html` too
when `external_store_link` isn't set.

## Public Booking Page (`frontend/book.html`)
The manual, always-available counterpart to Cal.com sync and the AI auto-send — a client with no
Cal.com account (or who just wants a simple link with zero external dependency) can hand out
`book.html?client=<id>` directly: to customers, in a WhatsApp bio, on a website, or pasted into
`main_prompt`/`kb_text` so the bot mentions it. A customer picks a service (if any are listed),
enters name/phone, picks a preferred date/time, and submits — landing as a `requested` row in
`appt_table_ids.bookings` for staff to confirm, exactly like a booking-intent detection would, just
initiated by the customer directly instead of inferred from conversation.
- Same security shape as the ecommerce public storefront (`store.html`/`onshope-store.html`): only
  `/appt/public/*` endpoints (`worker.js`), a fixed field whitelist on both the client record
  (`APPT_PUBLIC_CLIENT_FIELDS`) and each service row (`APPT_PUBLIC_SERVICE_FIELDS`), and exactly
  one write path — submitting a booking — which can only ever create a `requested` row, never
  read/update/delete anything. A spammed or malicious submission can only add noise for staff to
  dismiss, not corrupt existing data.
- **`GET /appt/public/client?client=<id>`** / **`GET /appt/public/services?client=<id>`** —
  both 404 with a generic "Booking page not found" unless `appt_enabled==='Yes'`, so a client who's
  turned the module off (or never turned it on) doesn't have a live public page sitting around.
- **`POST /appt/public/book`** (`handleApptPublicBook`) — body:
  `{client_id, name, phone, service_id?, date?, time?, notes?}`. Requires `phone` and a client with
  the module actually set up (`appt_table_ids.bookings` resolvable); everything else is optional —
  a customer can submit with just a phone number and no preferred time, and staff follows up. Calls
  the same `advanceLeadBookingAndTask()` helper the rest of this feature uses, now passing an
  `explicitWhen` `{date, time}` — see below.
- **`advanceLeadBookingAndTask()` (`worker.js`) gained an optional `explicitWhen` parameter.**
  Every other caller (the AI auto-send, the outgoing-message watch, `POST /leads/booking-link`)
  only knows *intent* — no specific date/time yet — so they dedupe on "this phone already has a
  `requested` row" to avoid spamming duplicates as intent gets re-detected across a conversation.
  A public-page submission is a real, distinct booking with its own date/time, so it skips that
  dedupe and always inserts — `source:'public'` distinguishes these rows from `'bot'` (intent-only)
  and `'calcom'` (external sync) ones. The task it drops is worded "Review booking" instead of
  "Confirm booking" to reflect that a specific slot was actually requested, not just hinted at.
- The outgoing-message watch (`CHATWOOT_HOOK_LINK_RE`, part of the zero-n8n auto-tracking webhook)
  now also recognizes `book.html?client=<id>` as a link shape, alongside the built-in ecom
  storefront link — so if the bot mentions the public booking page in its own words (per the
  KB-injection fallback above), that still gets picked up and logged the same way.

## Appointment Booking module (`frontend/dashboard.html` — Appointments tab)
A full, detailed module for services businesses (healthcare, consultancy, and anything else
`isBookingIndustry()` covers — every industry but Ecommerce) to manage bookable services and the
actual appointments, plus optional automatic sync from Cal.com. Follows the same architecture as
the Travel Agency and Recruitment/Consultancy modules — **not** Ecommerce's: per-client NocoDB
tables (not one shared table with a `client_id` column), created on demand, with CRUD going
straight from the browser to NocoDB through the existing session-authed `/nocodb` passthrough
(`handleNocodbPassthrough`, `worker.js`) rather than dedicated `/appt/*` worker routes.

**Enabling it — Settings → 🧩 Modules:** this new consolidated section is also a bug fix in
passing — Travel Agency's manual toggle never existed in the markup (only a hidden dead
span/button), and Recruitment's toggle had a duplicate-id bug where `$id('cfgRecruitEnabled')`
always resolved to a second, hidden, non-functional copy of the element, so the visible dropdown's
clicks went nowhere. Both now have one real, working `<select>` + Save button here, same ids
(`cfgTaEnabled`/`saveTaEnabled`, `cfgRecruitEnabled`/`saveRecruitEnabled`) so their existing JS
(`initTaSettings`/`initRcSettings`, the click listeners) needed no changes — it was already
correct, just shadowed. **Appointment Booking's row (`#apptModuleRow`) only shows for
`isBookingIndustry()` clients** — an ecom client has no use for an appointments calendar. Toggling
it on ensures `appt_enabled`/`appt_table_ids`/`calcom_webhook_secret` columns exist on CLIENTS and
writes `appt_enabled`.

**Fixed: the tab didn't reappear on next login.** `showApp()` (fires once per login, after
`clientRecord` loads) already re-applies `updateAgencyTabVisibility()`/`updateRecruitTabVisibility()`
so those tabs show up immediately — the equivalent `updateApptTabVisibility()` call was missing for
Appointments, so the tab only appeared once the user happened to open Settings (the only place that
was calling it, via `initApptSettings()`). Also added `apptMergeLocal()` — TA/Recruit already had
this fallback (`taMergeLocal`/`rcMergeLocal`, both called from `showApp()`), `apptSaveLocal()` had no
matching read-back.

**Fixed: "Enabled" not actually saving.** `saveApptEnabled`/`apptSetupTables()` originally had
`await patchClient(...).catch(()=>{})` — `patchClient()` re-fetches after every write and throws a
specific "Save didn't take effect for: X" error if a field didn't actually stick (e.g. the column
doesn't exist, or a NocoDB schema-cache lag right after creating one), and that `.catch(()=>{})` was
silently swallowing it. The UI showed "✓ Saved"/"✓ Tables created!" regardless of whether the write
actually landed — a client could toggle the module on, see success, and the public booking page
would still 404 with "Booking page not found" because `appt_enabled` never actually changed server-
side. Both now let the real error surface instead of masking it. `apptSaveLocal()`'s local-cache
write also moved to *after* a confirmed-successful `patchClient()` call (it was firing
unconditionally before, which meant `apptMergeLocal()` — the fix directly above — could paper over
a real failure with a value that was never actually saved, undermining its own point).

**The module itself, 📅 Appointments tab (gated by `appt_enabled==='Yes'`, `updateApptTabVisibility()`):**
- First visit prompts **"Create Tables Now"** (`apptSetupTables()`) — creates two per-client tables,
  `Appt_Services_<clientId>` and `Appt_Bookings_<clientId>`, and stores their ids as
  `appt_table_ids` JSON (`{services, bookings}`) on the client row. Idempotent re-run, same pattern
  as `taSetupTables()`/`rcSetupTables()`.
- **Dashboard sub-tab**: today/upcoming/completed/requested counts, upcoming-appointments list.
- **Services sub-tab**: what the business offers — name, duration, price, currency, active/inactive
  — a simple catalog, not tied to Ecommerce's `products` table at all.
- **Appointments sub-tab**: the actual bookings — customer name/phone, linked service (optional),
  date, time, status (`requested`/`confirmed`/`completed`/`cancelled`/`no_show`), notes, filterable
  by status. `source` distinguishes how a row was created: `manual` (rep, via "+ New Appointment"),
  `bot` (the booking-link automation below), `calcom` (Cal.com sync below).

**Cal.com Sync (optional), Settings → 🗓️ Cal.com Sync (shown once the module is enabled):** not
OAuth — Cal.com doesn't offer a simple third-party OAuth flow for this. Instead the client creates
a webhook themselves in their own Cal.com account (Settings → Developer → Webhooks), pastes the
URL shown here (`{WORKER_BASE}/calcom/webhook/{clientId}`) as the endpoint, picks "Booking
Created"/"Booking Cancelled" (and optionally "Booking Rescheduled") as events, and sets a secret —
the same secret gets pasted into `cfgCalcomSecret` here (`calcom_webhook_secret` on CLIENTS).
- **`POST /calcom/webhook/<clientId>`** (`worker.js`, `handleCalcomWebhook`) — client_id comes from
  the URL path itself (Cal.com webhooks don't carry any other client-identifying field), not a
  session or a shared app secret. Verifies `X-Cal-Signature-256` — **hex**-encoded HMAC-SHA256,
  unlike Shopify's base64 (`verifyCalcomWebhookHmac` vs `verifyShopifyWebhookHmac`) — against that
  client's own `calcom_webhook_secret` (per-client, since each client's Cal.com webhook secret is
  theirs, not one app-wide secret the way Shopify's `SHOPIFY_API_SECRET` works for an installed
  app). Upserts into `appt_table_ids.bookings`, keyed by Cal.com's own booking `uid` so
  `BOOKING_RESCHEDULED`/`BOOKING_CANCELLED` update the same row instead of duplicating it.
- Cal.com's webhook payload shape (`payload.attendees[0]`, `payload.startTime`, `payload.title`,
  event names like `BOOKING_CREATED`) is based on Cal.com's documented webhook format and
  defensively parsed, but — same honest caveat as the Chatwoot webhook handler above — hasn't been
  verified against a live payload from a specific client's Cal.com account/plan.

**Booking-link automation now feeds this module too:** `advanceLeadBookingAndTask()` (`worker.js`,
shared by `POST /leads/booking-link` and `handleChatwootMessageHook`'s non-ecom fallback — see
"Non-ecom industries" above) now also inserts a `requested`-status row into
`appt_table_ids.bookings` (source `bot`, no date/time yet since the customer hasn't picked one)
whenever the client has the Appointment module set up — in addition to advancing the lead stage and
dropping the follow-up task it already did. Deduped on "this phone already has a `requested` row"
so a bot repeating the booking link across turns doesn't spam duplicate appointment rows. A client
using the built-in Appointment module (rather than just the lead-stage/task fallback) now gets
booking-intent detections landing directly in their Appointments list, same as a Cal.com sync would.

**`POST /ai/booking-signal`** (`handleAiBookingSignal`) — the piece that was actually missing for a
*fully automatic* "order intent found → booking link sent" loop for services clients.
`/ai/order-signal` (above) exists for ecom, but it's hard-coded to ecom's product catalog and
phrased for "a business selling physical products" — not reusable as-is for a services business
with no product table. This is the booking-industry equivalent: client_id-based, no session, same
n8n-calls-Cloudflare shape. Body: `{client_id, message}`. Screens one incoming message for booking
readiness (explicit "I want to book/schedule", or a specific question about availability/duration/
price of one service) using the client's own **Services** catalog from the Appointment Booking
module (`apptResolveTable(c,'services')` — only services with `status!=='inactive'`). Returns
`{signal:false}`, `{signal:true}` (no confident service match), or
`{signal:true, service_id:"..."}`. **Kept as pure detection, not merged with sending the link**,
same reasoning as `/ai/order-signal`: n8n calls this on incoming messages, and on `signal:true`
calls `POST /leads/booking-link` (passing `service_id` through if matched) to actually send it —
two calls, so n8n stays the one deciding whether its own bot also replies to that message, avoiding
the double-reply risk a single combined detect-and-send call would reintroduce.
- **`POST /leads/booking-link` now accepts an optional `service_id`** — when the Appointment
  module has a matching, active service, the WhatsApp message names it specifically ("book your
  *Initial Consultation* (30 min)" vs. the generic "here's the link to book"), and the
  `requested`-status row `advanceLeadBookingAndTask()` logs into `appt_table_ids.bookings` carries
  `service_id`/`service_name` instead of blank ones — same upgrade the appointment gets from a
  Cal.com sync, just sourced from AI detection instead.
- **For this whole loop to do anything useful, the Appointment Booking module needs to actually be
  enabled** (Settings → 🧩 Modules, `appt_enabled==='Yes'`, tables created via "Create Tables Now")
  — without it, `/ai/booking-signal` still works but always returns `{signal:true}` with no
  `service_id` (empty services catalog), and the booking-link send/lead-advance/task-drop still all
  work as before, just without a services catalog or an Appointments list to log into. n8n calling
  `/ai/booking-signal` → `/leads/booking-link` is meaningful for any booking-industry client either
  way; it's specifically the "which service, and does it show up in an Appointments tab" upgrade
  that needs the module turned on.

## Thin API proxy (Cloudflare Worker — cloudflare-worker/worker.js)
`dashboard.html` used to embed the **master NocoDB token** directly (any visitor could read/
write every client's row in every table via devtools — not just their own), plus each logged-in
client's own `chatwoot_token`/`wa_token`/`openrouter_key` sat in browser memory. This Worker
closes both: it holds the master NocoDB token and looks up each client's Chatwoot/Meta/
OpenRouter tokens server-side, per request — none of that ever reaches the browser anymore.

**Why Cloudflare Workers and not a self-hosted container**: an earlier attempt used a Node
service on the same Coolify host as the rest of this stack, but frontend and backend are
separate Coolify resources with no shared Docker network, so the browser couldn't reach it
without extra domain/DNS setup. A Worker is just a URL — no networking config, and the free
tier (100K requests/day) covers this comfortably.

**How login threads through it**: the browser hands the Worker's `/session/exchange` the raw
authorization `code` + PKCE `code_verifier` straight off Authentik's redirect — the Worker does
the code→access_token exchange itself (`POST {AUTHENTIK_BASE}/application/o/token/`, still a
public-client PKCE exchange: `client_id`/`redirect_uri` travel in the request body since neither
is secret, both already sit in `dashboard.html`'s own `CONFIG`) before verifying it against
Authentik's `/userinfo` endpoint, looking up the CLIENTS row by `authentik_email`, and issuing its
**own** signed session token (HMAC, `SESSION_SIGNING_KEY` secret) valid for 24h. Collapsing what
used to be two sequential browser round trips (browser→Authentik token endpoint, then
browser→Worker) into one matters most right after a mobile full-page redirect back from
Authentik — that's the "waiting on the login screen again" part of the flow, and the
Worker→Authentik hop now runs over Cloudflare's own network instead of the user's connection.
`{access_token}` alone (the older shape) still works — `autoProvisionAndLogin`'s second call,
after a brand-new signup finishes onboarding, still uses it directly since it already has a
verified access token in hand from the first exchange. This avoids needing OAuth refresh-token
logic in the browser altogether, since Authentik's access tokens are only valid a few minutes.
Every subsequent call sends the Worker's own session token as `Authorization: Bearer …`.

**Routes**: `/session/exchange`, `/session/me` (resume on page reload), `/nocodb/*` (generic
passthrough — every existing `ncGet`/`ncPatch`/`ncPost`/`ncDelete` call site in `dashboard.html`
is unchanged, only `CONFIG.NOCODB_BASE` and the auth header moved), `/chat/send`, `/quote/send`,
`/wa/templates` (GET list / POST create), `/wa/send`, `/ai/complete` (OpenRouter).

**Deploy**:
```
npm install -g wrangler          # if not already installed
cd cloudflare-worker
wrangler secret put NOCODB_TOKEN         # the master NocoDB token (nc_pat_...)
wrangler secret put SESSION_SIGNING_KEY  # a long random string, e.g. `openssl rand -hex 32`
wrangler secret put AUTHENTIK_API_TOKEN  # User Management → Create New User — see "Dashboard login" above
wrangler secret put ONBOARD_WEBHOOK_PASSCODE  # POST /session/auto-provision's fallback call to the external onboarding webhook — see "Dashboard login" above
wrangler secret put CHATWOOT_PLATFORM_TOKEN  # Channels module — see "Channels module" section below
wrangler secret put META_APP_ID              # Channels module — Meta Tech Provider app id
wrangler secret put META_APP_SECRET          # Channels module — Meta Tech Provider app secret
wrangler deploy
```
Also set `CHATWOOT_INSTANCE_BASE` as a plain (non-secret) var in `wrangler.toml`'s `[vars]` —
it's the base URL of the Chatwoot install the Channels module provisions new accounts on.
Copy the resulting `https://leadvyne-api-proxy.<your-subdomain>.workers.dev` URL into
`dashboard.html`'s `WORKER_BASE` constant (replacing `REPLACE_WITH_WORKER_URL`), and redeploy
the frontend.

**Known gap**: `ecom.html` still embeds the master NocoDB token directly and is **not yet
migrated** to this Worker. `dashboard.html`, `index.html`, `admin.html`, and now `broadcast.html`
(see "Campaigns module" below) are fully migrated.

## Admin panel (admin.html)
`admin.html` used to hold **three** master credentials in plaintext, extractable via view-source
regardless of its passcode login screen: the master NocoDB token, a full n8n API key, and the
admin passcode itself (used only to gate the UI — the token below it made that gate cosmetic).
It's now on the same Worker-session pattern as `dashboard.html`:

- `POST /admin/login` checks the passcode against `ADMIN_PASSCODE` (a new Worker secret) and
  returns a signed admin session token (same HMAC scheme as per-client sessions, reusing
  `SESSION_SIGNING_KEY`, but with a `{role:'admin'}` payload so the two token types can never be
  confused for each other).
- `/admin/nocodb/*` is a generic passthrough for everything the admin panel already did (client
  grid, edit modal, suspend/activate) — same shape as `/nocodb/*` but admin-authenticated instead
  of scoped to one client, and with no per-row ownership check (admin needs every row).
- The n8n API key fields were unused dead config (never actually called anywhere) — removed
  rather than re-wired. Re-add via a proper Worker-side proxy if you want that functionality back.

**New Worker secret**: `ADMIN_PASSCODE` — set via `wrangler secret put ADMIN_PASSCODE`, or
Cloudflare Dashboard → your Worker → Variables and Secrets (encrypt it).

**Billing Overview tab**: separate from the per-client self-service Billing page — this is the
admin's own oversight tool, since a logged-in customer's Billing page only ever shows *their own*
account.
- `GET /admin/clients-billing` lists every client's `plan_name`/`plan_status`/`plan_renews_at`/
  `wa_credits_balance`/`voice_addon_active` straight from NocoDB (fast, no per-row Stripe calls).
- `POST /admin/billing-refresh` (body `{client_id}`) — same live Stripe pull as the customer's
  own "Sync Subscription Now", just admin-triggered for an arbitrary client. Shares its core logic
  (`runBillingSync`) with the customer-facing route rather than duplicating it.
- `POST /admin/billing-portal-link` (body `{client_id}`) — opens that specific customer's Stripe
  Customer Portal for the admin to inspect, again sharing core logic (`runBillingPortalLink`)
  with the customer-facing `/billing/portal` route.
- `POST /admin/billing-reset-anchor` (body `{client_id, prorate}`) — "⏱ Reset Cycle" button, admin
  control over a customer's **billing period**: resets `billing_cycle_anchor` to `now` on that
  customer's Stripe subscription, so their renewal date becomes today instead of waiting out the
  current period. `prorate:true` charges/credits the customer for the shortened/lengthened period
  (`proration_behavior:'create_prorations'`); `false` changes only the date, no invoice impact.
  Stripe's Subscription Update only accepts `'now'`/`'unchanged'` for this field — there's no way
  to set an arbitrary custom renewal date without a Subscription Schedule, which isn't implemented
  here. Two confirms in `admin.html` before this fires, since it can trigger an immediate charge.

## Channels module (self-service Chatwoot + WhatsApp connection)
The old flow required an admin to manually create a Chatwoot account, create a WhatsApp Cloud
inbox by hand, and paste four Chatwoot fields plus `waba_id`/`wa_token`/`wa_phone_id` into
Settings. The **Channels** page (new sidebar tab, `dashboard.html`) automates all three steps
using two credentials that are separate from everything else in this repo — neither ever
reaches the browser:

| Secret (Worker) | What it is | Where to get it |
|---|---|---|
| `CHATWOOT_PLATFORM_TOKEN` | Chatwoot **Platform API** access token — creates Accounts/Users. Platform tokens can only see objects they created themselves, never accounts made through the normal UI. | Chatwoot Super Admin console → Platform Apps → create one → copy its access token |
| `CHATWOOT_INSTANCE_BASE` (plain var, not secret) | The base URL of the Chatwoot install these new accounts are created on | e.g. `https://app.yourchatwoot.com` |
| `META_APP_ID` / `META_APP_SECRET` | Your Meta Tech Provider app — `META_APP_SECRET` does the Embedded Signup code→token exchange server-side | Meta Developer Portal → your Tech Provider app |

`dashboard.html`'s `CONFIG.META_APP_ID` / `CONFIG.META_WHATSAPP_CONFIG_ID` are **public** identifiers
(safe in browser JS — only `META_APP_SECRET` is a secret) used to launch Meta's Embedded Signup
popup. Get the Config ID from Meta Developer Portal → your app → WhatsApp → **Embedded Signup**
(this is the same Tech Provider/Embedded Signup approval used by Chatwoot's own native WhatsApp
Cloud onboarding — you don't need a second Meta app).

**Flow** (3 steps, each gated on the previous):
1. **Create Chatwoot Account** — `POST /channels/create-account`. Creates a Chatwoot Account +
   User via the Platform API, links the user as `administrator`, and writes
   `chatwoot_base`/`chatwoot_account_id`/`chatwoot_token` onto the CLIENTS row.
2. **Connect WhatsApp** — Embedded Signup popup returns a `code` (FB.login callback) plus
   `waba_id`/`phone_number_id` (posted via `window.message` by Meta's SDK). `POST
   /channels/whatsapp/connect` exchanges the code for a token, subscribes the app to the WABA,
   creates the WhatsApp Cloud inbox in Chatwoot (`provider_config: {business_account_id,
   phone_number_id, api_key}`), best-effort wires the inbox's webhook to the client's existing
   `webhook_url` (the n8n wrapper from onboarding), and writes `chatwoot_inbox_id`/`waba_id`/
   `wa_token`/`wa_phone_id`. Blocked (400) if this client already has WhatsApp connected, and
   blocked (409) if the same `waba_id`/`phone_number_id` is already on a *different* CLIENTS row
   — a WhatsApp number can only ever belong to one client's row, since the schema has a single
   `waba_id`/`wa_phone_id`/`chatwoot_inbox_id` slot.
   - **Manual fallback ("Wire Meta credentials directly")** — a `<details>` block under Step 2 for
     clients whose WhatsApp inbox was already set up straight in Chatwoot (or elsewhere) rather
     than through this Embedded Signup flow, so `waba_id`/`wa_token` never got written to their
     CLIENTS row. It's a plain form (WABA ID, System User access token, optional phone number id)
     that writes those fields straight onto the CLIENTS row via the generic `/nocodb` passthrough
     (`saveManualWaCreds()` → `patchClient()`) — same mechanism every other Settings field uses,
     since `waba_id`/`wa_token` aren't in the worker's `PROTECTED_CLIENT_FIELDS` list. No Chatwoot
     call is made at all, so it's safe to use even when a WhatsApp inbox already exists in
     Chatwoot: it only unblocks template create/list/send (`handleBroadcastTemplatesCreate` and
     friends), which need `waba_id`/`wa_token` but not `wa_phone_id`/`chatwoot_inbox_id`.
3. **Add Another Inbox** — `POST /channels/inbox` creates a Website widget, Email, SMS (Twilio),
   Telegram, LINE, or API inbox on the same Chatwoot account — the same channel types Chatwoot's
   own generic inbox API supports (`allowed_channel_types` minus `whatsapp`, which has its own
   OAuth route above). Multiple of these are allowed per account (unlike WhatsApp). They aren't
   written back to CLIENTS (nothing in the bot engine references them) — the response links
   straight to that inbox's settings page in Chatwoot for any manual finishing touches (widget
   styling, IMAP for email, etc).
**Folded into signup itself** — a brand-new customer no longer has to go find Settings → Channels
on their own. The moment a fresh signup logs in (`completeLoginResult`'s `session.isFreshSignup`
check, `dashboard.html`), `autoCreateChatwootAccountSilently()` fires step 1 above in the
background with no UI at all — by the time the Welcome Setup modal's business-name/industry step
is filled in, it's normally already done. `saveWelcomeSetup()` then shows a second Welcome Setup
step with a single "Connect WhatsApp" button (reusing `connectWhatsApp`/`completeWaConnect`,
now parameterized with a `msgElId`/`context` pair so the same Embedded Signup code path can report
into either the modal or the Channels page) — the one part of this that genuinely cannot be
automated, since only the WhatsApp number's own owner can authorize it with Meta. A "Skip for now"
option leaves it for Settings → Channels later; the step itself is skipped entirely if the account
already has WhatsApp connected, or if this deploy has no `META_APP_ID` configured. If the silent
Chatwoot creation happens to fail (e.g. `CHATWOOT_PLATFORM_TOKEN` misconfigured), the modal says so
plainly rather than showing a WhatsApp button that would just fail against a nonexistent account.

4. **Shopify** — Chatwoot's Shopify integration is itself an OAuth app configured at the
   *Chatwoot instance* level (`SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` env vars on that
   install, redirect URL `{chatwoot_base}/shopify/callback`) — that OAuth hop runs on Chatwoot's
   own domain and can't be done from this Worker. `GET /channels/chatwoot-sso` calls the Platform
   API's one-time login link (`/platform/api/v1/users/{chatwoot_user_id}/login`) so the client
   lands in Chatwoot already signed in (they were never shown the random password step 1
   generated), then they click Settings → Integrations → Shopify → Connect themselves.

**Status view**: `GET /channels/status` reads the client's real inbox list straight from
Chatwoot (`GET /api/v1/accounts/{id}/inboxes`), not just the local CLIENTS columns — the
Channels page uses this to show what's already connected and never offers to recreate it.

**New CLIENTS column**: `chatwoot_user_id` (Single line) — the Chatwoot user id created in step
1, needed for the Shopify SSO link. Add it alongside the other Channels-module fields.

**Not yet verified against a live instance**: the exact WhatsApp/SMS/Telegram/LINE
`provider_config`/field names and the webhook-create payload are taken from Chatwoot's
`develop` branch source, not a live test — worth a smoke test on your instance before relying
on it for production onboarding.

## Shopify module (order/fulfillment/abandoned-cart WhatsApp notifications, no n8n)
A separate connection from item 4 above — Chatwoot's Shopify integration only shows order
context inside a conversation. This one lets the Worker itself read a client's Shopify store
(order/fulfillment/checkout webhooks → WhatsApp templates straight through Meta's Graph API).
Connect, notification-template setup and the send log all live on one page now —
**Settings → Integrations** (`dashboard.html`) — instead of the connect step being there and the
notification setup living in a separate Ecommerce-module tab.

**One-time Shopify Partners setup:**
1. Create an app in [partners.shopify.com](https://partners.shopify.com) (Custom or Public
   distribution both work — this doesn't need to be listed on the Shopify App Store).
2. App URL: anything (not used by this flow). **Allowed redirection URL(s)**:
   `{WORKER_BASE_URL}/shopify/oauth/callback` (must match exactly, including scheme).
3. Copy the app's **Client ID** / **Client secret** → set as Worker secrets `SHOPIFY_API_KEY` /
   `SHOPIFY_API_SECRET` (`wrangler secret put ...`). `SHOPIFY_API_SECRET` also verifies both the
   OAuth callback's HMAC and every incoming webhook's HMAC — never let it reach the browser.
4. Set `WORKER_BASE_URL` in `wrangler.toml` `[vars]` to this Worker's real public URL (already
   defaulted to the production one — only change it if you run a staging Worker).

**New CLIENTS columns** (add alongside the Channels-module ones): `shopify_shop_domain`,
`shopify_access_token`, `shopify_connected_at`, `shopify_notify_config` (Long text, JSON — same
shape as `ecom_wa_templates`: `{config:{received,paid,shipped,delivered,abandoned}, templates:[...]}`),
`shopify_notify_log` (Long text, JSON array, capped at the last 30 entries).

**NocoDB table** `shopify_checkouts` (abandoned-cart tracking) — fields: `client_id`,
`checkout_token`, `phone`, `customer_name`, `cart_summary`, `total`, `currency`, `recovery_url`,
`created_at`, `nudge_sent`, `completed`. **Self-provisioning** — `getShopifyCheckoutsTableId()` in
`worker.js` creates this table itself (via NocoDB's Meta API, same one dashboard.html's own
`ensure*Column()` helpers already use client-side) the first time it's needed, and memoizes the
resolved id for the life of the Worker isolate. Nothing to create by hand or paste into a
constant — this used to require creating the table manually in NocoDB and pasting its id into a
`SHOPIFY_CHECKOUTS_TABLE` constant (same pattern as `EMAIL_CAMPAIGNS_TABLE`); that step is gone.

**New Ecommerce Orders column** `shopify_order_id` (Single line text) — add this to whatever
table `ecom_table_ids.orders` resolves to (the shared default `mjqaeatoe88gay6`, or a client's own
override), alongside the existing `ORDER_FIELDS` columns (`order_id`, `customer_name`,
`customer_phone`, `order_date`, `items`, `total`, `currency`, `status`, `delivery_address`,
`notes` — see `ecom.html`). Every Shopify order webhook now also upserts a row into this same
table via `syncShopifyOrderToEcom()`, matched on `shopify_order_id` (Shopify's own numeric order
id, stable even if the merchant edits the order name) — so a Shopify order shows up in the
Ecommerce module's own Orders page (`ecom.html`) too, not just as a WhatsApp notification.
`status` tracks the lifecycle: `received` (order created) → `processing` (paid) → `shipped`
(fulfillment created) → `delivered` (best-effort, carrier-dependent) or `cancelled`.

**Flow:**
1. **Connect** — Settings → Integrations → Shopify → enter `yourstore.myshopify.com` → `POST
   /shopify/oauth/start` returns Shopify's authorize URL (client id + scopes + a signed `state`
   carrying the client id) and the browser navigates there directly (full-page redirect, not a
   popup — Shopify's authorize screen refuses to render in an iframe/popup on some plans).
2. **Callback** — `GET /shopify/oauth/callback` verifies Shopify's query-param HMAC, verifies
   `state`, exchanges `code` for a permanent access token, registers the eight webhooks this
   module needs (`orders/create`, `orders/paid`, `orders/cancelled`, `fulfillments/create`,
   `fulfillments/update`, `checkouts/create`, `checkouts/update`, `app/uninstalled`) pointing at `/shopify/webhook`,
   writes `shopify_shop_domain`/`shopify_access_token`/`shopify_connected_at`, then redirects back
   into `dashboard.html?shopify=connected` (or `?shopify=error&msg=...`). This is the "automatic
   webhook" — Settings → Integrations → Shopify shows the endpoint URL for reference/debugging
   once connected, but there's nothing to paste into Shopify by hand; the OAuth callback registers
   it directly via Shopify's Admin API. **Stores connected before `orders/paid` was added** won't
   have that webhook registered — disconnect and reconnect (Settings → Integrations → Shopify) to
   pick it up; reconnecting re-runs the full webhook registration step.
3. **Notifications** — set up per-event WhatsApp templates right below the connect card on the
   same **Settings → Integrations** page (`GET /ecom/wa-templates` pulls approved templates
   straight from Meta's Graph API — no n8n
   hop, unlike the existing Order Delivery Notifications section which still uses the
   `leadvyne-ecom-wa-templates` n8n webhook). `POST /shopify/webhook` verifies each webhook's
   HMAC over the raw body, then sends the matching template via `sendShopifyNotification` and
   appends the attempt (sent/skipped/failed) to `shopify_notify_log`.
   - **No template yet for an event?** Each event block has a "✨ Create Suggested Template"
     button — `POST /ecom/wa-templates/create-preset` (`{client_id, kind}`) submits a ready-made
     Meta Utility template from the server-side `SHOPIFY_TEMPLATE_PRESETS` map (`worker.js`) to
     that client's WABA for review, and pre-selects it (with the correct `{{n}}` → vars mapping
     already saved) so nothing else needs configuring once Meta approves it. `abandoned` is
     submitted as `MARKETING` category (a re-engagement nudge, not a transactional confirmation)
     — everything else is `UTILITY`.
   - **Faster alternative for `received`/`paid`/`shipped`**: a "⚡ Use Meta Library Template"
     button — `POST /ecom/wa-templates/create-from-library` (`{client_id, kind}`) creates a
     template from Meta's own **Template Library** instead (pre-vetted wording Meta maintains
     globally, not per-WABA — per Meta's docs these skip the review queue entirely, unlike the
     from-scratch preset above). `SHOPIFY_LIBRARY_TEMPLATES` (`worker.js`) holds the three
     confirmed real `library_template_name` values (`order_management_1`,
     `payment_confirmation_4`, `shipment_confirmation_1` — found via WhatsApp Manager → Message
     templates → Create template → Browse the template library; this catalog is global, so these
     three names are reused for every client, no per-client lookup). Unlike the preset button,
     this one does **not** pre-fill the `{{n}}` → vars mapping — the library wording has several
     same-typed placeholders (e.g. multiple `{{text}}` slots) with no confirmed way found yet
     (Meta's own docs blocked automated access while building this) to know which slot means what
     without live-testing against a real WABA — so it falls through to the same manual
     param-mapping UI every other synced template already uses. No confirmed library entry exists
     yet for `delivered`/`abandoned`.
4. **Abandoned cart** — `checkouts/create`/`checkouts/update` upsert into `shopify_checkouts`;
   `orders/create` marks the matching checkout row `completed`. A second Cron Trigger
   (`*/20 * * * *` in `wrangler.toml`, dispatched to `sweepAbandonedShopifyCheckouts` in
   `scheduled()`) nudges any checkout that's 60+ minutes old, not completed, and not already
   nudged — replacing the n8n `followup-template.json` pattern for Shopify carts specifically.

**Known limitation**: Shopify only reports a fulfillment as `delivered` for carriers it tracks
natively — the "Order Delivered" notification is best-effort and won't fire for every order.

**Disconnect**: `POST /shopify/disconnect` (Settings → Integrations) clears the stored
domain/token on this side. It does not revoke the app from the Shopify Admin — for a full
uninstall the merchant should also remove the app from their store's Apps page.

## Hospitality module (`frontend/dashboard.html` — 🏨 Hospitality tab; houseboats/hotels/tourism stays)
A new industry (`hospitality`) plus an independently-toggleable module (`hospitality_enabled`,
Settings → 🧩 Modules — same pattern as Travel Agency/Recruit/Appointments/B2B: industry selection
auto-enables it, but it can also be toggled manually), for businesses that manage their own stay
inventory — houseboats, hotels, resorts — rather than an agency arranging trips to third-party
destinations (that's Travel Agency) or a single time-slot service (that's Appointments). The core
thing neither of those two modules has is a **date-range + unit-type availability calendar with
occupancy-based pricing**, which is what this module actually is.

**Architecturally different from Agency/Recruit/Appointments**: those three each provision their
own dynamic per-client NocoDB tables through the generic `/nocodb/*` passthrough. Hospitality is
instead **fully Cloudflare D1** (`env.DB`, `migrations/0009_hospitality.sql`) via dedicated
`/hospitality/*` Worker routes — a genuinely new data shape (date ranges, per-date rate overrides,
overlap-checked bookings) with no NocoDB view anywhere already reading it, so there's no reason to
pay NocoDB's per-client-table-creation overhead for it. Same reasoning as the Accounting/Follow-up
Engine/Coach D1 tables elsewhere in this file.

**Schema** (`migrations/0009_hospitality.sql`):
- `hospitality_units` — unit/room types (name, type/category, adult/child capacity, amenities
  (a plain comma-separated string, not JSON — kept simple since it's just rendered as chips, never
  parsed/queried), `base_rate`, an optional flat `weekend_rate`, currency, active flag).
- `hospitality_blocked_dates` — manually blocked dates per unit (maintenance, owner-blocked, etc.).
  Sparse — availability is "open unless a confirmed/checked_in/checked_out booking or a row here
  says no," not a dense per-date table pre-populated for the whole future.
- `hospitality_rate_overrides` — sparse per-date price overrides (peak season, festival pricing)
  beyond a unit's own flat `weekend_rate`.
- `hospitality_bookings` — a date-range stay (`check_in`/`check_out`, not a single time-slot),
  `lead_id` linking back to the CRM lead when the booking came from a WhatsApp conversation
  (`guest_name`/`guest_phone` stand alone for one entered directly with no CRM lead behind it),
  `status` (`inquiry`/`confirmed`/`checked_in`/`checked_out`/`cancelled`) — only the three
  non-inquiry, non-cancelled statuses ("occupying" statuses) actually block the same
  unit/date-range for another booking, so an unconfirmed inquiry never blocks someone else.

**Worker routes** (`cloudflare-worker/worker.js`, all session-gated with ownership checks, same
pattern as the Accounting module's routes): `GET/POST/PATCH/DELETE /hospitality/units`,
`POST/DELETE /hospitality/blocked-dates`, `POST /hospitality/rates`, `GET /hospitality/availability`
(merges blocked dates + rate overrides + booked ranges for one unit over a date range into a
per-date status list — the calendar UI's single data source, so it isn't stitching three fetches
together itself), `GET/POST/PATCH/DELETE /hospitality/bookings` (create/update reject with a 409 if
the requested range overlaps another occupying-status booking on the same unit), `GET
/hospitality/stats` (dashboard totals — active unit count, this-month occupancy rate as
booked-nights ÷ (active units × days in month), this-month revenue, upcoming check-ins/check-outs
in the next 7 days).

**Frontend** (`frontend/dashboard.html`) — same sub-nav/lazy-load convention as Recruit/Appointments
(`renderHospitality()` → `renderHospSubPage(page)`, a `.hosp-tab`/`data-hosp` sub-nav, one shared
`#hospContent` container):
- **📊 Dashboard** — stat tiles (units, occupancy, upcoming check-ins, revenue) + upcoming
  check-in/check-out lists.
- **🏠 Units** — an editable table (`renderHospUnits()`/`hospUnitRow()`), not a card grid and no
  Add/Edit popup at all: every field — name, type, currency, capacity, rates, amenities,
  description, and even photos/video — is edited inline in its own cell, autosaving via a `PATCH
  /hospitality/units` call on blur/change (`hospUnitCellChange()`). "+ Add Unit"
  (`hospAddUnitRow()`) creates a unit with placeholder defaults immediately (`POST
  /hospitality/units`) and focuses its Name cell so it's ready to type over. Photos/video are 4
  small inline slots per row (`hospMediaCellHtml()`) — click a slot to upload directly, no modal to
  open first (see "Unit photos/video" below).
- **📅 Availability** — a real month-grid calendar per unit (`.hosp-day` cells, color-coded
  available/blocked/booked), with Prev/Next month nav and a click-a-day popover to toggle
  blocked/available or set that date's rate override. Built by hand with vanilla JS (no calendar
  library) — a `days-in-month` grid is simple enough not to need one.
- **📖 Bookings** — a filterable table (status), add/edit modal with automatic nights/total
  calculation from the unit's rate as check-in/check-out change.

**Unit photos/video + auto-send to chat** (`migrations/0010_hospitality_media.sql`) — each unit can
carry up to 3 photos and 1 video, one per its row's 4 inline media slots (no modal). Since units
are created immediately with a real id (see Units above), there's no "save first" step before media
can be attached.
- **Slots hold a pasted Google Drive share link, not an uploaded file.** Clicking an empty slot
  (`hospSetUnitMediaLink()`) prompts for a Drive share link and saves it via the same generic
  `PATCH /hospitality/units` every other unit field already autosaves through (`image_url_1/2/3`,
  `video_url` — plain string columns, `handleHospitalityUnitUpdate`). The file must be shared
  **"Anyone with the link can view"** — this Worker fetches it anonymously, with no Drive account
  behind it. A filled slot shows a small thumbnail (`driveThumbnailUrl()` — Drive's public
  `/thumbnail?id=` endpoint serves real image bytes, unlike the "view" share link itself which is
  an HTML page and won't render in a plain `<img>`) for photos, or a 🎬 icon for the video slot;
  clicking it opens the Drive link directly, and the ✕ removes it (still `POST/DELETE
  /hospitality/units/media`'s DELETE side, which nulls the column and best-effort cleans up any
  legacy R2 object — a harmless no-op when there's no R2 object behind a Drive link).
- **Why the switch**: simpler for a rep already organizing photos in their own Drive, no file-size
  cap to hit, and no per-client R2 storage to manage for this. `driveFileId()` (duplicated in both
  `worker.js` and `dashboard.html`, same as this file's other small helpers — no shared build step)
  extracts the file id from whichever share-link shape was pasted (the normal
  `/file/d/<id>/view?usp=sharing` share link, or an `?id=<id>` open/uc link).
- **Legacy R2 uploads still work, not migrated.** Units that already had a file uploaded before
  this switch keep their `https://<worker>/hospitality/media/<key>` URL and keep serving/sending
  fine — `handleHospitalityUnitMediaUpload`/`Delete`/`handleHospitalityMediaServe` and the R2
  binding (`HOSPITALITY_MEDIA`) are all still in place, just no longer reachable from the frontend
  (nothing calls the upload endpoint anymore). `hospitalitySendUnitMedia()` below checks for that
  URL shape first and only treats anything else as a Drive link, so both kinds of units send
  correctly side by side without anyone needing to re-paste an already-working unit's media.
- **Auto-send to chat, once per (lead, unit)** — `engineMaybeSendHospitalityMedia()`, called from
  `handleEngineWebhook` right after the lead upsert on every real inbound message, in two modes:
  - **Specific enquiry** — the message names one active unit (simple case-insensitive substring
    match of the unit's `name`, not an LLM call, so it's cheap and predictable but can both
    under-match — a guest describing a unit without its exact name — and over-match — a very
    short/generic unit name appearing inside an unrelated word; a client naming units something
    distinctive avoids both). Only that unit's media is sent.
  - **General enquiry** — no specific unit named, but the message reads like someone asking what's
    available at all (`HOSPITALITY_GENERAL_ENQUIRY_RE` — a keyword list: room(s), available,
    options, rates, packages, etc., same "cheap heuristic, not an LLM call" tradeoff). Every active
    unit's media is sent, one at a time, so a first-time enquirer sees the whole catalog instead of
    getting nothing until they happen to name a unit by chance.
  Both modes share `hospitalitySendUnitMedia()` for the actual send, which now fetches each item's
  bytes from wherever they actually live — R2 for a legacy URL (unchanged), or Google Drive for
  everything else via `driveFetchFile(driveFileId(url))`. Every non-empty slot on the unit is sent,
  not just the first one that resolves — a slot whose bytes can't be fetched (unshared file, wrong
  link, or one Drive's "can't scan for viruses" interstitial won't release even with the `confirm=t`
  bypass `driveDirectUrl()` tries first) is silently skipped rather than sending garbage/an HTML
  page as "the photo," while the other slots on the same unit still go through normally. "Once per
  session" means once per (lead, unit) **ever**, tracked in `hospitality_media_sent` (unique on
  `lead_id, unit_id`) — a unit already sent (from either mode) is never resent to that lead, and the
  general-enquiry mode additionally only fires at all if this lead has never received *any* unit's
  media yet (so asking "any rooms available?" twice doesn't re-flood the chat with the whole catalog
  every time). Each unit's media sends as separate Chatwoot attachment messages (one per photo/
  video, same multipart-attachment mechanism the rest of this file already uses for Chatwoot sends
  — a real image, not a link) with a short caption on the first one only.

**Timezone note**: the calendar's month-boundary date math is done with plain string/number
arithmetic, not a `Date` → `toISOString()` round-trip — the latter converts a local midnight
through UTC, which silently shifts the date by a day for any positive-UTC-offset user (IST, GST,
etc. — this app's actual client base), truncating the calendar's last day. Worth remembering if
this module grows more date logic — Cloudflare Workers themselves have no such trap (there's no
"local timezone" server-side, `Date` is always UTC there), but browser-side JS very much does.

## B2B module (Smart Lists, trackable Documents/CPQ, brand classification, B2B analytics)
A new industry (`b2b`) plus an independently-toggleable module, following the same pattern as
Travel Agency/Recruitment/Appointments: **Settings → Modules → 🤝 B2B Suite** turns on a `🤝 B2B`
nav tab, which embeds `frontend/b2b.html` in an iframe (same "own self-contained page, `?client=`
in the query string" approach as Ecommerce's `ecom.html` — see "Ecommerce embedded as a real nav
tab" below — except b2b.html is also passed a `token=` (the dashboard's session token), because
it reads/writes Leads fields through the same `/nocodb/*` passthrough dashboard.html itself uses,
which requires a bearer token; `ecom.html` never touches Leads so it never needed one).

**New LEADS columns** (self-migrating — `ensureB2bLeadFields()` in `worker.js` creates these the
first time the module touches them, same pattern as `flow_state`): `Brand` (Single line text —
which brand/product line the enquiry is for), `Country` (Single line text — feeds the
Country/Continent report), `b2b_events` (Long text, JSON array of `{type, at, meta}`, capped at
the last 50 — a behavioral log of `doc_view`/`doc_accepted` events, read by Smart Lists' "viewed/
accepted a document in the last N days" rule).

**New CLIENTS columns** (self-migrating on save, same pattern as `ta_enabled`): `b2b_enabled`
(Single line text, Yes/No — module toggle) and `b2b_segments_json` (Long text, JSON — saved Smart
List definitions: `[{id, name, rules:[{field, op, value}] | {field:'behavior', value, days},
createdAt}]`, read/written straight through `/nocodb/*` from `b2b.html`, protected by the same
single-record-Id check the passthrough already does for every other CLIENTS field).

**Documents live in Cloudflare D1** (`env.DB`, table `b2b_documents` — see
`migrations/0002_accounting_b2b_documents.sql` and "Storage split: NocoDB vs. Cloudflare D1"
below), not a NocoDB table you create by hand: `client_id`, `lead_id`, `type` (`quote`/`catalog`),
`title`, `brand`, `line_items_json` (JSON array of `{name, qty, price}`), `currency`, `subtotal`,
`tax_pct`, `total`, `status` (`draft`/`sent`/`viewed`/`accepted`/`expired`), `public_slug` (unique
— the `?slug=` token in the shared link), `view_count`, `last_viewed_at`, `accepted_at`,
`created_at`, `expires_at`, `notes`. Apply the migration once (`wrangler d1 migrations apply
leadvyne-d1 --remote`) and it's ready — no per-deployment table-creation step, no env var to set.
Every `/b2b/documents*` route derives `client_id` server-side from the session (same as before
this migration) rather than trusting anything client-supplied, and every response still returns
the document's id as `Id` (capitalized) so `b2b.html` needed no changes at all.

**Trackable links & CPQ**: creating a quote/catalog in b2b.html's Documents tab generates a
`public_slug`; the shareable link is `b2b.html?slug=<slug>` (works standalone, outside the
dashboard iframe — it's served as a public page, no login). Opening it (`GET /b2b/doc/:slug`,
no session) logs a view (`view_count`, `last_viewed_at`, a `doc_view` event on the linked lead)
and flips `draft`/`sent` → `viewed`. For quotes, an **"Accept Quote" button** (`POST
/b2b/doc/:slug/accept`, no session) records `status='accepted'` + `accepted_at` — click-to-accept
only, deliberately no e-signature capture in this phase.

**Smart Lists**: saved segment rules (Stage/Tags/Brand/Country equals-or-contains, plus a
"Behavior" rule keyed on `b2b_events`) evaluated client-side in `b2b.html` against the same
`/nocodb/*`-fetched lead list the rest of the dashboard uses — no server "preview" endpoint, same
client-side-filter approach Campaigns' Stage filter already uses.

**Analytics & Brand/Country broadcast**: Brand-based enquiries, Country/Continent-based leads
(small static lookup table in `b2b.html`, not a NocoDB table) and Sales-person (`Owner`, already
an existing LEADS column) reports are all aggregated client-side from the same lead list. Each
report row's "📢 Broadcast" button deep-links to `broadcast.html?brand=X&country=Y&stage=Z`,
which now reads those query params on load (`applyFilterPresetsFromUrl()`) to preset two new
`Brand`/`Country` filter dropdowns added next to the existing Stage filter on both the Direct
Message and Meta Template tabs — sending itself still goes through the pre-existing
`/broadcast/send-dm`/`/broadcast/send-template` routes, untouched.

**Out of scope for this phase** (needs external credentials/decisions the deployer must supply
before these can be built): LinkedIn Post Automation via LinkedIn's direct API (needs a LinkedIn
developer app + OAuth), Apify-based lead scraping (needs the specific Apify Actor id(s) to map
into Leads), Google-Sheet stock sync via an n8n webhook, and chat-content-based B2B client
classification.

## Real Estate module (`frontend/real-estate.html` — 🏘️ Real Estate tab; lead scoring, tower/floor/
unit inventory, site visits, bookings & payment schedules, channel partners, RERA compliance)
Same pattern as B2B above: **Settings → Modules → 🏘️ Real Estate** turns on a `🏘️ Real Estate` nav
tab (auto-enabled when Industry is set to "Real Estate", same as Hospitality/Travel/Consultancy —
see `applyIndustryChange()`), which embeds `frontend/real-estate.html` in an iframe, passed both
`client=` and `token=` (it reads/writes Leads through `/nocodb/*` and its own `/re/*` Worker
routes, both bearer-token gated).

**Storage split**: Lead fields (source portal, project interest, budget, urgency, zone, language,
auto-score, investor flag, channel-partner attribution) are plain LEADS columns — self-migrating
via `ensureRealEstateLeadFields()`, same pattern as B2B's Brand/Country: `re_source`, `re_project`,
`re_budget` (Number), `re_urgency`, `re_zone`, `re_language`, `re_score` (Number), `re_investor`,
`re_cp_id` (Number). Every existing lead view (kanban, lead list, Team Performance, exports)
already reads leads out of NocoDB and gains these for free. New CLIENTS columns (self-migrating,
`ensureRealEstateClientFields()`): `real_estate_enabled`, `re_segments_json` (Smart Lists, same
shape as B2B's), `re_agent_routing_json` (round-robin rules, `[{agent, zones:[], projects:[],
languages:[]}]`), `re_rr_state_json` (round-robin pointer per matching rule set), and
`re_webhook_secret` (issued on first `/re/init`).

Everything with a genuinely new shape is Cloudflare D1 (`env.DB`, `migrations/0031_real_estate.sql`
— apply once with `wrangler d1 migrations apply leadvyne-d1 --remote`, same as every other D1
module here), same "sidecar data with no other NocoDB reader" reasoning as Hospitality:
`re_projects`, `re_units` (tower/floor/unit, `status` available/hold/blocked/booked/sold/
resale_listed, `hold_expires_at` — swept back to `available` on every `GET /re/units`),
`re_site_visits`, `re_bookings`, `re_payment_milestones`, `re_tickets` (post-possession
complaints), `re_channel_partners` (KYC + commission slab + a unique `portal_token`),
`re_cp_commissions`, `re_documents` (RERA/brochure/floor-plan links), `re_price_audit` (one row
per changed `base_price`/`plc_charges`/`floor_rise_charges`, written by `handleReUnitUpdate`).

**Lead Management & Scoring**: `reProcessNewLead()` in `worker.js` is the single entry point for
every capture path — the public multi-source webhook (`POST /re/webhook/lead?client_id=&secret=`,
gated by the per-client `re_webhook_secret` shown in real-estate.html's "🔌 Lead Capture" tab, for
portal/Zapier/Make.com/website-form integrations), the module's own "+ Add Lead" (walk-ins/
referrals, `POST /re/leads`, session-gated), and the Channel Partner portal (below). It always:
(1) **dedups** by the last-10-digit normalized phone number — a match merges the new source into
the existing lead's `re_source` (comma-separated) instead of creating a second row, so "the same
lead from 3 portals" shows as one record with three sources; (2) **auto-scores** with a simple,
explainable heuristic (`computeLeadScore` — budget present +20, urgency High/Medium/Low +40/20/5,
has a project interest +15, has a booked site visit +25, capped at 100) — deliberately not a
trained model, mirrored client-side as `computeLeadScoreClient()` so `real-estate.html` can rescore
after a site visit is booked without another round-trip; (3) **auto-assigns** via round-robin
(`pickRoundRobinAgent()`) against `re_agent_routing_json`, cycling through whichever agents' zone/
project/language rules match. `GET /re/leads/duplicates` additionally re-scans every existing lead
by phone for the "🧬 Find Duplicates" button, covering leads entered before this module existed.

**Inventory**: tower → floor → unit (`re_units`), each with `base_price`/`plc_charges` (Preferential
Location Charges)/`floor_rise_charges` and a project-level `base_price_per_sqft`/
`price_list_version` (`re_projects`) for price-list versioning. "Hold" (`PATCH /re/units` with
`status:'hold', hold_hours`) sets `hold_expires_at`; the next `GET /re/units` sweeps any expired
hold back to `available`. Any price-field change on `PATCH /re/units` writes a `re_price_audit` row
(old/new value, `changed_by`, `reason`) — RERA-style audit trail for price/discount changes,
readable in the "📜 Price Audit" modal.

**Site Visits → Bookings → Payments**: `re_site_visits` schedules a viewing (lead + unit/project +
transport/driver notes — reminders/calendar sync are out of scope, see below); `POST /re/bookings`
books a unit (flips it to `status='booked'`, clears any hold) with a `token_amount`, `total_price`
and `payment_plan` (construction-linked/down-payment/flexi/possession-linked); if a channel partner
is attached, it auto-creates the first `re_cp_commissions` row (`amount = total_price ×
commission_slab_pct`) — further tiered/milestone payouts are just more rows added later against the
same `booking_id`+`cp_id`. `re_payment_milestones` is the demand-note schedule per booking (name,
due date, amount, `status` pending/due/paid/overdue, `demand_note_sent_at` — "sending" a demand
note is a manual "mark as sent" flag here, not a real notification send; wire it into Campaigns'
broadcast if you want an actual WhatsApp/email demand note). Cancelling a booking
(`status:'cancelled'`) re-opens its unit to `available`; "List for Resale" flips it to
`resale_listed` for the Post-Sales tab's resale/renewal tracking.

**Post-Sales**: `re_tickets` for post-possession complaints (booking-linked, priority, status).
Possession/handover is just the booking's own `status='possession'` + `possession_date` — no
separate table, since it's one more state on the same record everything else already tracks.

**Channel Partners**: `re_channel_partners` (name/company/KYC status/commission slab), each issued
a unique `portal_token` at creation. The **partner portal** (`real-estate.html?cp=<portal_token>`,
no login) is a public page — `GET /re/cp-portal/:token` returns the partner's own bookings/
commissions, `POST /re/cp-portal/:token/leads` lets them submit a lead through the exact same
`reProcessNewLead()` path as every other source (rate-limited, see `RATE_LIMIT_RULES`).

**Marketing**: Smart Lists (`re_segments_json`) — identical rule-engine to B2B's, matched against
Project/Zone/Urgency/Investor/Stage/Source — each with a "📢 Broadcast" button deep-linking into
`broadcast.html`; actual template approval and sending stay entirely in Campaigns, unchanged.

**Analytics**: funnel by source/project (leads → site visits → bookings, computed client-side from
the leads/visits/bookings the page already loaded, same approach as B2B's Analytics tab), agent
leaderboard (`Owner`, existing LEADS column), inventory velocity (`GET /re/analytics`, a live
`GROUP BY status` over `re_units`/`re_bookings`/`re_site_visits`/`re_tickets`), and a per-source ROI
table where spend is a manual client-side input (no ad-platform spend API wired in).

**Investor dashboard**: bookings flagged `is_investor` are grouped by buyer in the Documents tab,
showing units held, total value, and loan status across every project — built from data this
module already has, not a separate table.

**Deliberately manual / out of scope** (needs external credentials/APIs the deployer must supply):
portal-specific webhook formats for 99acres/MagicBricks/Bayut/Property Finder (the generic
`/re/webhook/lead` JSON contract covers all of them via Zapier/Make.com — there's no public,
standardized webhook spec across these portals to integrate against directly); e-signature capture
(`agreement_url` is a link field to wherever you generate/host the signed agreement, same
"trackable link, not embedded signing" scope B2B's Documents accept as a deliberate limit); loan/
mortgage pre-approval status (`loan_status` on a booking is a manual dropdown a rep updates — no
lender has a public status-pull API this app can integrate against); virtual tour / 3D walkthrough
(a URL field on the project/unit, opened in a new tab — genuinely embeds whatever tour tool you
already use, just not iframed inline); predictive pricing/demand forecasting (the ROI table's
"spend" column and the funnel/velocity numbers are the forecasting surface for now — a real
model needs historical pricing data this module doesn't yet accumulate enough of).

## Accounting module (Quotation → Invoice → Receipt, ERPNext push)
> **Standalone update (migration `0035_accounting_standalone.sql`):** the module no longer
> depends on ERPNext for anything — the "⚙️ ERPNext Connection" and "👤 Customers" tabs described
> below have been removed from `accounting.html`, along with the ERPNext pickers in the Document/
> Expense/Vendor Bill modals and the "Sync/Publish to ERPNext" actions. Documents now carry a
> plain `customer_name` column for a walk-in/non-lead customer, status is changed via a local
> dropdown (`draft`/`sent`/`paid`/`void`), and Vendor Bills get a local "Mark Paid" action
> (`handleVendorBillMarkPaid`, `accounting_vendor_bills.paid_at`). The `erpnext_*` columns, push
> functions (`erpnextPushSalesDoc` etc.), and `/erpnext/*` lookup routes described in the rest of
> this section are all still in the codebase and functional — they're just no longer wired to any
> UI — so the ERPNext-specific documentation below still explains what those backend pieces do,
> just not how a client reaches them today. See "AI-Supported Bookkeeping" further down for what
> replaced the "book this to an external system" workflow.

A `💰 Accounting` nav tab, **always visible — not gated behind any industry flag or Settings →
Modules toggle** the way B2B/Agency/Ecommerce/Recruit/Appointments are, since quoting/invoicing an
existing lead is a fit for every client regardless of what they sell. Embeds `frontend/accounting.html`
in an iframe, same pattern as B2B (`?client=` + `?token=` in the query string — needs the session
token for the same reason b2b.html does: it reads/writes Leads through the bearer-token-gated
`/nocodb/*` passthrough).

**Documents live in Cloudflare D1** (`env.DB`, table `accounting_documents` — see
`migrations/0002_accounting_b2b_documents.sql`, `migrations/0004_accounting_erpnext_customer.sql`,
`migrations/0005_accounting_company_debtors.sql` and "Storage split: NocoDB vs. Cloudflare D1"
below), not a NocoDB table you create by hand:
`client_id`, `lead_id`, `type` (`quotation`/`invoice`/`receipt`), `title`, `line_items_json` (JSON
array of `{name, qty, price}`, optionally `item_code` when the line was picked from the live
ERPNext item list — see below), `currency`, `subtotal`, `tax_pct`, `tax_amount`, `total`, `status`
(`draft`/`sent`/`paid`/`void`/`accepted` — used loosely per type, no strict per-type state
machine), `linked_doc_id` (an invoice's source quotation, or a receipt's source invoice; `NULL`
for a document created standalone), `notes`, `erpnext_customer` (an ERPNext `Customer.name`,
optional — set when the document was created against a picked ERPNext customer rather than a CRM
lead), `erpnext_doctype`, `erpnext_doc_name`, `erpnext_sync_status` (`NULL` / `synced` / `failed`),
`erpnext_sync_error`, `erpnext_synced_at`, `doc_created_at`. Apply the migrations once
(`wrangler d1 migrations apply leadvyne-d1 --remote`) and it's ready — no per-deployment
table-creation step, no env var to set, and no more NocoDB-specific `doc_created_at`-not-`created_at`
naming trap (a plain SQL column, not subject to NocoDB's auto-added system field). Every
`/accounting/*` route derives `client_id` server-side from the session (same as before this
migration), and every response still returns the document's id as `Id` (capitalized) so
`accounting.html` needed no changes at all.

**Customers tab** (`accounting.html`, "👤 Customers") — a live list of this account's own ERPNext
`Customer` records (`GET /erpnext/customers`, `handleErpnextCustomersList`; no local mirror table,
fetched fresh on every page load, same "no persisted mapping" choice as the resolve helpers below),
with search and a "+ Add Customer" action (`POST /erpnext/customers`, `handleErpnextCustomerCreate`
— creates the Customer directly in ERPNext, unlike `erpnextResolveCustomer`'s silent
search-or-create) and a "🧾 New Invoice" action per row that opens the Document modal pre-filled
with that customer. Both routes 400 with a clear message if the account hasn't connected ERPNext
yet (⚙️ tab) — this tab is simply hidden behind that same gate, not its own separate setup step. A
third route, `POST /erpnext/customers/ensure` (`handleErpnextCustomerEnsure`), wraps
`erpnextResolveCustomer` itself (search-or-create, safe to call repeatedly) — used by the Human
Deals page's "✅ Won" button (see "Human Deals page" below) to land a won lead in this same
Customers list without a document ever needing to exist.

**Customer/item picking in the Document modal** — a "ERPNext Customer" dropdown
(populated from the same `/erpnext/customers` list) lets a document be tied to a real ERPNext
customer directly (`erpnext_customer` column above) instead of always going through the CRM lead
picker; when set, `erpnextPushSalesDoc`/`erpnextPushPaymentEntry` use it as-is and skip the
by-name resolve entirely. Line items get a `<datalist>` of live ERPNext item names
(`GET /erpnext/items`, `handleErpnextItemsList`) so typing a product suggests existing ERPNext
items — matching one exactly still goes through `erpnextResolveItem`'s by-name lookup at sync time
(no `item_code` is captured client-side for a typed/free-text line), so this is picking by name,
not a strict foreign-key reference; a genuinely unambiguous per-line item reference would need a
real `<select>` per row instead of a datalist, which wasn't built here.

**Company + Debtors Account picking** (`migrations/0005_accounting_company_debtors.sql` —
`accounting_documents.company`/`erpnext_debtors_account`) — a "Company (ERPNext)" dropdown
(`GET /erpnext/companies`, `handleErpnextCompaniesList`) and a "Debtors Account" dropdown
(`GET /erpnext/accounts`, `handleErpnextAccountsList` — filtered to `account_type='Receivable'`,
and to that Company once one's picked, since ERPNext's `Account` doctype is itself
company-scoped; `onDocCompanyChange()` re-fetches the account list whenever Company changes, and
also adopts that company's `default_currency` into the Currency field as a starting point, still
overridable). `company` is passed straight through to whichever doctype gets synced — every one of
Quotation/Sales Invoice/Payment Entry accepts it, and Frappe requires it once a site has more than
one Company. `erpnext_debtors_account` only means something on Sales Invoice (`debit_to`) and
Payment Entry (`paid_from`) — a Quotation has no such field, so it's simply unused for that type.
Left blank on either, ERPNext resolves its own default account from the Customer/Company exactly
as it would without this feature. Currency itself stays a plain text input, not a hard `<select>`
— given a `<datalist>` of live ERPNext currencies (`GET /erpnext/currencies`,
`handleErpnextCurrenciesList`) instead, so typing still works (and the field still functions) even
without ERPNext connected, rather than hard-requiring an ERPNext round-trip just to type a currency
code.

**No GST, by design** — this module never adds a tax line: `tax_pct` is forced to `0` on every
create/update regardless of what a caller sends (`handleAccountingDocumentCreate`/`Update`), the
Tax % field is gone from the Document modal, and `erpnextPushSalesDoc` no longer ever builds a
`taxes` array. A document created before this rule still shows its original tax on its PDF
(`buildDocumentPdf` only prints the Tax row when `tax_pct > 0`) and still has its stored
`tax_amount`/`total` untouched — this only changes what new documents can do going forward.

**"📮 Publish" — submitting the synced document in ERPNext** (`migrations/0006_accounting_erpnext_submit.sql`
— `accounting_documents.erpnext_submitted_at`). "🔄 Sync to ERPNext" only ever creates the document
over there as a Draft (Frappe `docstatus 0`) — it doesn't post to the ledger until it's Submitted
(`docstatus 1`), which is a separate, explicit action in ERPNext itself. A "📮 Publish" button
appears once a document is synced and not yet submitted (`POST /accounting/documents/submit-erpnext`,
`handleAccountingDocumentSubmitErpnext`) — fetches the full current document from ERPNext, then
calls Frappe's whitelisted `frappe.client.submit` method with it (rather than trying to PATCH
`docstatus` directly on the resource endpoint, which isn't reliably supported across Frappe
versions). One-way: a submitted Frappe document generally can't go back to Draft without a Cancel
first, which this integration doesn't do, so the button asks for confirmation. The ERPNext badge
distinguishes the three states: "Not synced" → "✓ Synced (draft)" → "✓ Published". Not
live-verified against a real Frappe Cloud site in this session, same honest caveat as the rest of
this ERPNext integration.

**Full-page PDF layout** (`buildDocumentPdf`) — modeled on a typical modern invoice template: a
logo mark top-left with a large italic-serif document-type wordmark ("Invoice"/"Quotation"/
"Receipt") top-right, a "Billed to:" block against the document number and date, a clean-lined
item table (no filled header — just a bold rule under the column names and thin gray row
dividers), a Subtotal/Tax/**Total** summary with Total picked out in a solid color bar (white
text), an italic "Thank you!" line (jsPDF only ships the core Helvetica/Times/Courier faces, so
this stands in for a true script font rather than being one), a "Payment Information" block, and a
signature block (business name + address) bottom-right. All branding — logo, accent color
(defaults to black/white now, matching this template's own look, still overridable), header title,
footer address, payment info, terms — is the same `quote_logo_url`/`quote_accent_color`/
`quote_header_title`/`quote_footer_address`/`quote_payment_methods`/`quote_terms`/`invoice_terms`
CLIENTS data the Quotation feature already has, read straight off the same `clientRecord` this page
already loads — deliberately **not** a second copy of those settings; there is exactly one place to
edit logo/terms/etc. (a lead's Quote/Invoice page under Human Deals), and every PDF this module
generates, plus the Quotation feature's own, picks up the same values (the Document modal says so
directly). `quote_payment_methods` (Human Deals → Quote/Invoice → "Payment Information") is now a
multi-line field, not a single-line one, so it can hold full bank details (bank name, account name,
account number — one per line) instead of only a short list of accepted methods; existing
single-line values keep working unchanged. The document number printed is `erpnext_doc_name` once
synced (e.g. `SINV-2026-00001`, the real ERPNext-issued number) — falling back to this document's
own local id before that, since there's nothing else to show yet. There's no invented "due date" —
nothing in this app tracks one today, so nothing is shown rather than fabricating a date.

**Send Invoice by Email** — a "📧" action per document row builds the same PDF the download button
does (`buildDocumentPdf`, refactored so both share one jsPDF build), then posts it as a base64
Resend attachment (`POST /accounting/documents/send-email`,
`handleAccountingDocumentSendEmail` → `sendClientResendEmail`'s new `attachments` param — Resend's
own `[{filename, content}]` shape, `content` base64). Requires the client's own Resend connection
(Settings → Bulk Marketing, `resend_api_key`/`resend_from_email` — the same per-client Resend
account the Email Marketing module uses, not a platform-level key) — same "best-effort, never a
hard dependency" pattern as everywhere else Resend is used in this file: sending fails with a clear
error if unset rather than silently no-op'ing, but nothing else in the Accounting module depends
on it. A draft document is marked `sent` once the email succeeds, same as a WhatsApp send.

**Connected to the Human Deals Quotation/Invoice flow** (`dashboard.html`'s `openQuoteFor`/
`quoteSend`, opened from a Human Deals lead card's Send Quote/Invoice button) — every WhatsApp
send now also best-effort creates a matching `accounting_documents` row (status `sent`,
line items mapped from that flow's own service catalog) and, if the client has already connected
ERPNext, immediately fires `sync-erpnext` for it too — so a quote/invoice sent straight from a
lead's chat shows up in the Accounting module and (if connected) in ERPNext automatically, with no
separate manual "save to accounting" step. This mirroring can silently fail (network hiccup, D1
briefly unavailable) without affecting the WhatsApp send itself, same tolerance as the existing
ConvHistory/Tags logging in that function — check the Documents tab if a send doesn't appear there
as expected.

**Lifecycle**: create a Quotation against an existing lead (title, line items, tax %, currency,
notes) — `handleAccountingDocumentCreate`. Once it's ready to become billable, **Convert**
(`POST /accounting/documents/convert`, `handleAccountingDocumentConvert`) creates a new draft
Invoice pre-filled from the quotation's line items/totals/lead, linked back via `linked_doc_id` —
deliberately a new record rather than mutating the source in place, so the original quotation stays
exactly as sent/agreed. The same Convert action turns an Invoice into a draft Receipt once paid.
Each document can be downloaded as a simple itemized PDF (`downloadDocumentPdf` in
`accounting.html`, jsPDF + jspdf-autotable — same CDN libraries the Agency Quotation feature in
`dashboard.html` already loads, but a plainer layout deliberately with no logo/branding, since this
spans every industry rather than just travel).

**ERPNext (Frappe) push — one-way only, per-client credentials.** Each of this app's own clients
runs their own separate ERPNext/Frappe Cloud site, so the connection is per-CLIENTS-row, not a
single shared integration: three new CLIENTS columns, `erpnext_base_url` (e.g.
`https://yoursite.frappe.cloud`), `erpnext_api_key`, `erpnext_api_secret` (Settings → Accounting →
ERPNext tab in `accounting.html`; same plaintext-on-CLIENTS convention as `wa_token`/
`chatwoot_token`/`openrouter_key` elsewhere in this file — no dedicated secrets vault for per-client
credentials anywhere in this codebase). Generate the API Key/Secret pair in ERPNext under
**Settings → My Settings → API Access**.
- **"Sync to ERPNext"** (`POST /accounting/documents/sync-erpnext`,
  `handleAccountingDocumentSyncErpnext`) pushes the document as a real ERPNext doctype: Quotation
  and Invoice map to ERPNext's own `Quotation`/`Sales Invoice` doctypes (`erpnextPushSalesDoc`),
  Receipt maps to a `Payment Entry` (`erpnextPushPaymentEntry`) — a "Receive" payment from the
  customer, allocated against the source invoice's own ERPNext document name if that invoice was
  itself synced first (`linked_doc_id` → the linked document's `erpnext_doc_name`); if it wasn't,
  the receipt still posts as an unallocated payment against the customer rather than blocking the
  sync outright.
- **Customer/Item auto-resolution** (`erpnextResolveCustomer`/`erpnextResolveItem`): ERPNext's
  Quotation/Sales Invoice/Payment Entry doctypes all require a real `Customer` record and each line
  item's `item_code` to reference a real `Item` record — there's no way to post a sales document
  against a bare name string. Both helpers search by name first (`customer_name`/`item_name`) and
  create a minimal record (Item as a non-stock `Services`-group item) on no match, rather than
  requiring the client to pre-map every lead/service to exact ERPNext master data before a document
  can sync. This trades some chart-of-accounts tidiness for the document actually going through — a
  client who wants tighter control can still pre-create the exact Customer/Item names in ERPNext
  themselves, since auto-create only fires when no matching name is found.
- **Tax**: a flat percentage line (`charge_type:'On Net Total'`) is added to the ERPNext document
  when `tax_pct > 0`, with no `account_head` specified — ERPNext will require one to actually save
  the tax row in most chart-of-accounts setups; this is a known gap deliberately left for the
  deployer to map (which income/tax account a synced document should post against depends entirely
  on that client's own ERPNext accounts, which this integration has no way to know).
- **Failure handling**: every sync failure — HTTP error, a thrown Customer/Item create, ERPNext's
  own validation errors (parsed from Frappe's `exception`/`_server_messages` response shape via
  `erpnextErrorMessage`) — is caught, written back onto the document (`erpnext_sync_status:'failed'`,
  `erpnext_sync_error`, visible as a badge with the error as a tooltip in `accounting.html`), and
  reported via `reportOpsError`. The local document record is never blocked on ERPNext sync
  succeeding — create/convert/PDF/send all work with or without ERPNext connected; sync is always a
  separate, retriable action.
- **Frappe REST API assumptions**: token auth (`Authorization: token {api_key}:{api_secret}`),
  standard resource endpoints (`POST /api/resource/<Doctype>`, `GET
  /api/resource/<Doctype>?filters=[[...]]`) — not live-verified against a real Frappe Cloud site in
  this session (no ERPNext instance reachable from this environment); test a real sync against your
  own site's chart of accounts/tax setup before relying on it for real customer documents.

### Expense Entry (`frontend/accounting.html` — "💸 Expense Entry" tab, `cloudflare-worker/migrations/0028_accounting_expenses.sql`)
A general "book a one-off expense against this client's own ERPNext" flow, separate from
`accounting_documents` (Quotation/Invoice/Receipt — customer-facing sales documents) and from
Financial Planning's `fp_expenses`/`fp_expense_templates` (local-only recurring/fixed-cost
bookkeeping, migration 0015 — **never** pushed to ERPNext, and unaffected by this feature).

- **Modeled as an ERPNext Journal Entry**, not Purchase Invoice or Expense Claim — a Journal Entry
  needs only a `Company` and two GL `Account`s (one debited, one credited) to post; Purchase
  Invoice requires a `Supplier` master record and Expense Claim requires an `Employee` +
  `Expense Claim Type` (not a real Chart-of-Accounts account) to exist first. Debits the picked
  **Expense Account**, credits the picked **Paid From** account, both for the entry's amount
  (`erpnextPushExpenseEntry`, `worker.js`).
- **Company** and **Expense Account** are the two selections that actually decide what gets booked
  and where — reuses the existing Company picker (`handleErpnextCompaniesList`) unchanged. Both
  Expense Account and Paid From Account come from a shared, generalized `GET /erpnext/accounts`
  (`handleErpnextAccountsList`) — previously hardcoded to `account_type=Receivable` for the
  Documents modal's Debtors Account field only; now accepts `?root_type=Expense` /
  `?root_type=Asset` (every ERPNext Account has a `root_type` — Asset/Liability/Income/Expense/
  Equity — a more reliable filter than `account_type`, which plain ledger accounts often leave
  blank) while defaulting to the original `Receivable` behavior when neither query param is passed,
  so the existing Debtors Account call site needed zero changes.
- **Paid From Account auto-suggests** from the picked Company's own `default_cash_account`
  (falling back to `default_bank_account`) the moment a Company is chosen — `default_cash_account`/
  `default_bank_account` were added to `handleErpnextCompaniesList`'s fetched fields for exactly
  this. Stays editable in case the expense wasn't actually paid from the company's default account.
- **Schema** (`accounting_expenses`, migration 0028): `client_id, company, expense_account,
  expense_account_name, paid_from_account, paid_from_account_name, amount, currency, expense_date,
  category, vendor, description, cost_center, status, erpnext_doctype, erpnext_doc_name,
  erpnext_sync_status, erpnext_sync_error, erpnext_synced_at, erpnext_submitted_at, created_at` —
  same sync/submit-status columns as `accounting_documents`, so the same badge UI
  (`expErpBadge`/`erpBadge`) and "🔄 ERPNext" / "📮 Publish" button pattern applies.
- **Create → Sync → Publish**, same 3-step flow as Documents: `POST /accounting/expenses` saves it
  locally only (`status:'unsynced'`); `POST /accounting/expenses/sync-erpnext` pushes the Journal
  Entry (still an editable Draft in ERPNext); `POST /accounting/expenses/submit-erpnext` calls the
  same `erpnextSubmitDocByName` used by Documents' Publish to post it. A synced expense can't be
  edited in place (delete-and-recreate instead) — mirrors the same reasoning as not letting a
  synced Document's line items be edited after the fact.
- **Not live-verified against a real Frappe Cloud site** in this session, same caveat as the rest of
  this ERPNext integration — in particular, verify the `accounts` child table field names
  (`debit_in_account_currency`/`credit_in_account_currency`) and that `cost_center` is accepted
  un-set (falls back to ERPNext's own default) against your actual Frappe version before relying on
  it for real bookkeeping.

### Vendor Bills (`frontend/accounting.html` — "📥 Vendor Bills" tab, `cloudflare-worker/migrations/0029_accounting_vendor_bills.sql`)
The accounts-payable counterpart to `accounting_documents`'s Quotation/Invoice/Receipt (which only
ever models the client's own sales) — what a client's own **supplier** billed *them*, pushed to
ERPNext as a real `Purchase Invoice`, then optionally a `Payment Entry` once it's actually paid.

- **Supplier** is a free-text field with autocomplete suggestions (`GET /erpnext/suppliers`, a
  `<datalist>` fed into `#erpSuppliersDatalist`), not a hard picker — same "type a name, it gets
  resolved-or-created on sync" pattern as the Documents modal's line-item names use for Items.
  `erpnextResolveSupplier` (worker.js) searches ERPNext's `Supplier` doctype by `supplier_name`
  first, creating a minimal one (`supplier_group:'All Supplier Groups'`, `supplier_type:'Individual'`
  — an assumption about a fresh site's default supplier group, same caveat as Item's
  `item_group:'Services'` guess) only when no match exists.
- **Company** and **Payable Account** reuse the exact same pickers/endpoints as Expense Entry and
  Documents: `handleErpnextCompaniesList` for Company, and the shared, generalized
  `GET /erpnext/accounts?company=<x>&account_type=Payable` for the Payable Account dropdown — no new
  backend endpoint needed, since that endpoint already accepts an arbitrary `account_type`/
  `root_type` filter (added for Expense Entry's Expense/Paid-From pickers).
- **Line items** work exactly like the Documents modal (same `.li-row` markup/JS, same
  `erpItemsDatalist` for product/service name suggestions, same by-name Item resolve-or-create via
  `erpnextResolveItem` on sync) — a vendor bill's line items are just as real as a sales invoice's.
- **`erpnextPushVendorBill`** (worker.js) posts `POST /api/resource/Purchase Invoice` with
  `supplier`, `items`, `bill_date`, and — when present — `bill_no` (the vendor's own invoice
  number, carried through to ERPNext's own "Bill No" field for reference/reconciliation),
  `due_date`, `company`, and `credit_to` (Purchase Invoice's own field name for the payable account,
  the accounts-payable mirror of Sales Invoice's `debit_to`).
- **Schema** (`accounting_vendor_bills`, migration 0029): `client_id, company, supplier,
  erpnext_supplier` (the resolved/created ERPNext Supplier name, captured on sync so the payment
  step below doesn't have to re-resolve it), `vendor_invoice_no, bill_date, due_date,
  line_items_json, currency, subtotal, total, notes, erpnext_payable_account, status` (`unpaid` |
  `paid`), plus the same `erpnext_doctype/doc_name/sync_status/sync_error/synced_at/submitted_at`
  columns `accounting_documents`/`accounting_expenses` use, plus `erpnext_payment_doc_name`/
  `erpnext_paid_at` for the payment step.
- **Create → Sync → Publish → Record Payment**, a 4th step beyond Documents/Expenses' 3:
  `POST /accounting/vendor-bills` saves locally only; `.../sync-erpnext` pushes the Purchase Invoice
  Draft; `.../submit-erpnext` publishes it (`erpnextSubmitDocByName`, same as Documents/Expenses);
  `.../record-payment` (only enabled once published) calls **`erpnextPushVendorBillPayment`** — a
  `Payment Entry` with `payment_type:'Pay'`, `party_type:'Supplier'` (the accounts-payable mirror of
  `erpnextPushPaymentEntry`'s `'Receive'`/`'Customer'` used for sales Receipts), allocated against
  the bill's own submitted Purchase Invoice via `references`, using `paid_to` (Payment Entry's field
  name for the target account on a Pay payment) from `erpnext_payable_account` when picked.
  Deliberately **not** a separate document row the way Receipt is for sales (quotation→invoice→
  receipt each get their own row so they can each be listed/searched independently) — a bill only
  ever has one payment status worth tracking (paid/unpaid), so it lives directly on the bill row
  instead of adding a second row type with no real independent lifecycle of its own.
- Same edit-lock-once-synced and delete-doesn't-cancel-in-ERPNext caveats as Expense Entry, and same
  **not live-verified against a real Frappe Cloud site** caveat as the rest of this integration —
  verify Purchase Invoice's exact required fields (some Frappe versions require `set_posting_time`
  or a default `Purchase Taxes and Charges Template` even with a zero-tax bill) and that `paid_to`/
  `credit_to` resolve correctly against your own chart of accounts before relying on this for real
  vendor payments.

## Billing module (Stripe — self-serve portal, add-on purchases, usage dashboard)
Implements: a self-serve billing portal (invoices, upgrade/downgrade, renewal date), in-app
add-on purchases (WhatsApp credits, voice add-on), and a client-facing usage dashboard
(messages sent, leads captured, conversion rate this month).

### Why the plan/add-on split is what it is (India RBI compliance)
RBI's e-mandate regulation covers **any recurring/auto-debit charge on an India-issued card**,
in any currency, regardless of where the merchant's Stripe account is registered:
- The cardholder's bank must notify them **at least 24h before** every recurring charge.
- Recurring charges **above ₹15,000** (or the mandate's registered cap) require the cardholder
  to re-authenticate (3DS/AFA) **each time** — this breaks silent auto-renewal above that amount.
- Stripe's supported path for this is **Subscriptions/Billing** (Checkout `mode=subscription` +
  the Customer Portal) — raw PaymentIntents/SetupIntents do **not** get e-mandate support.

That's why this implementation is split the way it is:
- **Plan subscriptions** → Stripe Checkout (`mode=subscription`) + Stripe Customer Portal for
  everything after (upgrade/downgrade/cancel/invoices/renewal date). Stripe handles e-mandate
  registration and coordinates the pre-debit notice automatically for India-issued cards.
  **Keep each plan's recurring price at or under ~₹15,000-equivalent** (check Stripe's current
  published threshold before launch) if you want renewals to stay silent for Indian customers —
  above that, every renewal will bounce the customer through a re-authentication step.
- **Add-ons** (WhatsApp credit packs, voice add-on) → one-time Checkout (`mode=payment`), not
  recurring line items. A one-time charge isn't an auto-debit, so it's outside the e-mandate
  rules entirely — no mandate, no 24h notice, no ₹15,000 cap. This was a deliberate choice
  (confirmed with you) over making add-ons recurring subscription items.

This is architectural guidance based on Stripe's public documentation, not legal advice —
confirm the current threshold and any newer RBI circulars before relying on it for a real launch.

### Plans are shown via a Worker-driven plan picker (not the Stripe Pricing Table)
Plan selection used to be a Stripe-hosted Pricing Table embed (Checkout Session created
client-side, Worker never involved). It's now `GET /billing/plans` + `POST
/billing/checkout-subscription` instead, for full control over the checkout call:
- `GET /billing/plans` reads `STRIPE_PLAN_PRICE_IDS`, fetches each Price (expanded with its
  Product) from Stripe, and returns `{price_id, name, unit_amount, currency, interval,
  interval_count}` per plan — skipping any placeholder entry (an id starting with `REPLACE_`,
  e.g. the not-yet-created Growth plan). `dashboard.html` renders these as plan cards, filtered to
  the Billing page's currency toggle (`_billingCurrency`), and caches the fetched list so flipping
  the currency toggle re-renders instantly instead of re-hitting Stripe.
- `POST /billing/checkout-subscription` (body `{price_id}`) — validates `price_id` against the
  same `STRIPE_PLAN_PRICE_IDS` allow-list, creates the Customer if needed, and creates the
  Checkout Session with `client_reference_id` **and** `subscription_data.metadata.client_id` both
  set to the logged-in client's row `Id` — the latter means `customer.subscription.*` webhook
  events can resolve the CLIENTS row directly from `sub.metadata.client_id`, no longer needing the
  `stripe_subscription_id`-lookup fallback that Pricing-Table-created subscriptions required (see
  `resolveClientIdForSubscription` — that fallback is kept only for subscriptions created before
  this change).

No publishable key or Stripe.js is needed in the browser at all now — every Stripe call happens
server-side in the Worker, same as add-ons already did.

### Multi-currency add-ons
Add-ons (WhatsApp credits, voice) are **not** part of the Pricing Table — Pricing Tables are
subscription-only, so these stay as our own one-time Checkout (`mode=payment`). If you sell them
in more than one currency, create a **separate Price object per currency** under the same
Product (Stripe's `currency_options` on a single Price is a different, auto-detected mechanism
and isn't what's implemented here). `CONFIG.BILLING_ADDONS` in `dashboard.html` is keyed
`{id, name, prices:{INR:{price_id,display}, AED:{price_id,display}, …}}` — the Billing page's
currency toggle (now scoped to just the Add-ons section) picks the matching Price ID.

### Stripe Dashboard setup
1. **Products/Prices for plans** (Product catalog → create) — add your recurring Prices there;
   set each Price's **nickname** to the human-readable plan name (e.g. "Growth") — the plan picker
   and the webhook both read this into the displayed name / `plan_name`. Optionally set metadata
   `message_limit` (e.g. `1000`) if you want a quota shown in the usage dashboard later. Copy each
   Price id into `STRIPE_PLAN_PRICE_IDS` (comma-separated) in `wrangler.toml` — no publishable key
   or pricing-table id needed anymore.
2. **Products/Prices for add-ons** (one-time, outside the Pricing Table) — one Price per add-on
   **per currency**. Set metadata on each Price (or its Product — the webhook merges both,
   Price wins):
   - WhatsApp credits pack: `fulfillment_type=wa_credits`, `wa_credits_amount=<number>` (added to
     `wa_credits_balance` on purchase).
   - Voice add-on: `fulfillment_type=voice_addon` (sets `voice_addon_active=Yes` on purchase).
   Fulfillment is keyed off the Checkout Session id (stored in `fulfilled_addon_events`), so a
   redelivered `checkout.session.completed` webhook won't grant credits/enable the add-on twice —
   requires the `fulfilled_addon_events` field on CLIENTS (see the schema table above).
3. **Customer Portal** (Settings → Billing → Customer Portal) — enable "Customers can switch
   plans" and list your plan Prices there; this is what makes upgrade/downgrade self-serve
   without any custom UI.
4. **Webhook endpoint** — add `{WORKER_BASE}/billing/webhook`, subscribe to `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `customer.subscription.trial_will_end`, `invoice.payment_succeeded`, `invoice.payment_failed`,
   `invoice.payment_action_required`, `checkout.session.expired`. The last five drive the branded
   trial-reminder/receipt/dunning/auth-required/abandoned-checkout emails — see "RBI pre-debit
   notification" and "Abandoned checkout recovery" below.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Use the **Snapshot** payload style, not
   Thin — the Worker's handler expects the full object inline on `event.data.object`.
5. **Customer emails** (Settings → Customer emails) — turn on "Successful payments" and "Failed
   payments" so customers also get Stripe's own receipt/dunning emails, on top of (not instead of)
   the branded ones this Worker sends. Also relevant to the RBI pre-debit notice below.
6. **Resend** — set the `RESEND_API_KEY`/`BILLING_FROM_EMAIL` Worker vars (see `wrangler.toml`) so
   the four webhook events above can actually send. If `RESEND_API_KEY` isn't set, billing still
   works fine — the emails just silently no-op, same "optional integration degrades gracefully"
   pattern as `/tasks/notify`.

### RBI pre-debit notification — verification checklist + backup layer
This billing flow has **never been smoke-tested against a live Stripe account** (see the caveat at
the end of this section) — treat the items below as things to actively confirm before relying on
them for real Indian customers, not as already-verified facts.

**1. Verify Stripe's own e-mandate notification is actually configured** (Stripe Dashboard, not
code — there's nothing to check in this repo for these):
- Settings → Payment methods → confirm card payments have e-mandate/recurring support enabled for
  India (this may require Stripe's India-specific onboarding/compliance forms if your Stripe
  account isn't already registered for Indian exports).
- Settings → Customer emails → "Upcoming renewals" (Stripe's own pre-debit reminder for
  Subscriptions) turned on, in addition to "Successful/Failed payments" from step 5 above.
- Run one real test-mode subscription with an Indian test card that requires 3DS/e-mandate
  authentication, and confirm you actually receive Stripe's pre-debit notice before a simulated
  renewal — don't assume it's firing just because the setting is toggled on.
- Confirm current RBI thresholds (the ₹15,000 auto-debit cap mentioned above, and the 24h notice
  window) against Stripe's current published docs — both are subject to change by RBI circular and
  this repo's guidance may be stale by the time you read it.

**2. Backup reminder layer (defense-in-depth / audit trail)** — lives in `cloudflare-worker/worker.js`
itself now (an earlier `n8n/rbi-renewal-notice.json` workflow filled this role before the whole
`n8n/` directory was removed from this repo; workflows are managed live in n8n going forward, not
committed here). `handleBillingWebhook` sends branded, Leadvyne-domain emails via Resend —
independent of whether Stripe's own notification (step 1) actually fires, and each one is a real
action, not just a notice:
- **`customer.subscription.trial_will_end`** — Stripe fires this ~3 days before a trial converts
  to a paid subscription. This *is* the pre-debit notice for that first charge: states the exact
  amount and date, and links straight to the Customer Portal to cancel before being charged.
- **`invoice.payment_succeeded`** — a branded receipt (amount, what it was for, next renewal date,
  a link to Stripe's hosted invoice PDF) sent right after every successful charge.
- **`invoice.payment_failed`** — states the amount that failed, when Stripe's Smart Retries will
  try again, and links straight to a Customer Portal session to update the payment method.
- **`invoice.payment_action_required`** — fires when a charge needs Additional Factor
  Authentication (RBI's AFA requirement for recurring debits above the auto-debit cap). Links
  straight to Stripe's hosted page to complete that authentication — this email unblocks the
  charge, it isn't just informational.
- All of these dedupe via `billing_emails_sent` on CLIENTS (see schema table above) so a
  redelivered webhook — Stripe retries on any non-2xx response or timeout — never double-sends the
  same email.
- This is a **backup/audit-trail layer**, not the compliance mechanism itself — it doesn't carry
  Stripe's own e-mandate/AFA registration mechanics. Treat step 1 as what actually satisfies RBI's
  rule and this as the branded, always-on second touchpoint plus a record of what each customer
  was told and when.

### Trial period
New plan subscriptions (`POST /billing/checkout-subscription`) start with a 15-day free trial
(`TRIAL_PERIOD_DAYS` in worker.js) before the first charge — Stripe owns the whole lifecycle from
there (status starts `trialing`, already synced into `plan_status`; no charge until day 15). The
`trial_will_end` email above is what tells the customer, ahead of time, exactly what they'll be
charged and when — and gives them a one-click way to cancel first if they don't want to continue.

### Abandoned checkout recovery
Both `handleBillingCheckoutSubscription` and `handleBillingCheckoutAddon` set
`after_expiration:{recovery:{enabled:true}}` on the Checkout Session they create — confirmed by
Stripe to work for `mode:'subscription'` as well as `mode:'payment'`, not just one-time payments.
Stripe does **not** email the recovery link itself; it only attaches a `after_expiration.recovery.url`
to the Session once it expires unfinished (usable for 30 days), delivered via the
`checkout.session.expired` webhook event. `handleBillingWebhook`'s handler for that event sends a
branded "Resume checkout" email with that link — same Resend/dedupe pattern as everything else in
this section. This is the actual fix for customers dropping off mid-3DS (a common India-card
failure mode): instead of a dead end, they get a link back to the exact same Checkout Session
rather than having to restart from the plan picker.
- **Note:** there is no Stripe Dashboard toggle that makes this happen automatically — the
  `after_expiration.recovery` API parameter plus a webhook-driven email (as built here) is the
  actual mechanism, not an account-level setting.
- Resolution uses `obj.client_reference_id||obj.metadata?.client_id` — both are now set at
  Checkout Session creation (`client_reference_id` was previously *documented* but not actually
  set on the subscription Checkout call; that's fixed as part of this change too, which also makes
  `checkout.session.completed`'s primary resolution path — rather than its email-match fallback —
  actually fire for subscriptions created through this app going forward).

### Worker config
| Secret/var | What it is |
|---|---|
| `STRIPE_SECRET_KEY` (secret) | Your Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` (secret) | Signing secret for the `/billing/webhook` endpoint |
| `STRIPE_PLAN_PRICE_IDS` (var, comma list) | Allow-list of recurring plan Price IDs — powers both `/billing/plans` and `/billing/checkout-subscription` |
| `STRIPE_ADDON_PRICE_IDS` (var, comma list) | Allow-list of one-time add-on Price IDs |
| `APP_BASE_URL` (var) | Dashboard URL Stripe redirects back to after Checkout/Portal (e.g. `https://app.leadvyne.com/dashboard.html`) |

### Confirming a subscription: pull-based, not just the webhook
The webhook's correlation (below) can still fail to link up for reasons outside the Worker's
control — a delayed/dropped webhook delivery, a direct/preview Stripe link bypassing
`dashboard.html` entirely, etc. Rather than only depending on that, there are two **pull-based**
routes that use the browser's own authenticated session (so there's no correlation to get wrong —
we already know which CLIENTS row this is):
- `GET /billing/confirm-session?session_id=cs_...` — fetches that specific Checkout Session from
  Stripe and syncs it onto the *currently logged-in* CLIENTS row directly. Called automatically
  when the Billing page loads with both `?billing=success` and `?session_id=...` in the URL —
  `handleBillingCheckoutSubscription`'s `success_url` already includes `?billing=success`, and
  `{CHECKOUT_SESSION_ID}` would need to be appended there too if you want `session_id` populated
  automatically (currently the confirm call silently no-ops without it, falling back to the
  webhook / manual sync below).
- `GET /billing/sync-now` — a manual "Sync Subscription Now" button on the Billing page. Looks up
  the Stripe Customer by the account's own email(s) (`authentik_email`/`team_emails`) if
  `stripe_customer_id` isn't set yet, then pulls whatever subscription exists for that customer.
  Useful any time a checkout completed on Stripe's side but hasn't shown up here — including
  retroactively fixing an account that got stuck before this existed, no need to redo the purchase.

### Flow
1. **Subscribe** — `GET /billing/plans` renders the plan cards, `POST
   /billing/checkout-subscription` (allow-listed Price IDs only) creates the Checkout Session and
   the Worker hands back a redirect `url`.
2. **Manage** — `GET /billing/portal` opens the Stripe Customer Portal for that customer —
   invoices, plan switch, payment method, cancellation, all Stripe-hosted.
3. **Buy an add-on** — `POST /billing/checkout-addon` (allow-listed Price IDs only) creates a
   one-time Checkout Session.
4. **Webhook** (`POST /billing/webhook`, signature-verified manually via Web Crypto — no Stripe
   SDK, this Worker ships as a single dependency-free file):
   - `checkout.session.completed` (mode=subscription): reads `client_reference_id`, writes
     `stripe_customer_id`, then fetches the Subscription directly and syncs `plan_name`/
     `plan_status`/`plan_renews_at` immediately — done this way (rather than waiting on a
     `customer.subscription.created` event) to avoid a race where that event can arrive first
     and has no CLIENTS row to resolve against yet.
   - `customer.subscription.updated`/`deleted` (renewals, cancellations, status changes):
     resolves the CLIENTS row via `sub.metadata.client_id` (set at checkout time by
     `subscription_data.metadata` above), falling back to a `stripe_subscription_id` lookup only
     for subscriptions created before this change (e.g. via the old Pricing Table, which had no
     way to set subscription-level metadata).
   - Add-on fulfillment (credits/voice) still reads the purchased Price's metadata — nothing
     about specific plans or add-on amounts is hardcoded in the Worker.
5. **Payment issues** — the Billing page shows a warning banner (linking to Manage Billing) when
   `plan_status` is `past_due`/`unpaid`/`incomplete`/`incomplete_expired`, which the webhook keeps
   in sync via the same `customer.subscription.updated` event Stripe fires on every retry/status
   change (Stripe's own Smart Retries drive these transitions — nothing to build for the retry
   logic itself).
6. **Billing period / expiry tracking** — the Billing page's "Customer Portal" card computes
   days-remaining client-side from `plan_renews_at` (no cron/scheduler needed — it's just
   `renews_at - now`, recomputed on every page load). If the customer cancels from the Stripe
   Portal, the subscription stays `active` with `cancel_at_period_end:true` until the period
   actually ends — the webhook now captures that into `plan_cancel_at_period_end`, and the
   Billing page swaps the "Renews in N days" line for "Ends in N days — won't renew" plus a
   dedicated banner, instead of silently showing a normal-looking renewal date.
7. **Company profile** — `POST /billing/company-profile` saves `client_name`/`company_address`/
   `billing_email` to the CLIENTS row and, if a `stripe_customer_id` already exists, best-effort
   pushes the same name/address/email to the Stripe Customer so it shows correctly on future
   invoices/receipts. `billing_email` is **required** by `ensureStripeCustomer` — no Stripe Customer
   (and therefore no subscription or add-on purchase) can be created without it, deliberately with
   no fallback to `authentik_email`, since that's just whichever address was used to log in, which
   for some clients is a shared/ops address rather than who should actually own the Stripe account.
   Both `subscribeToPlan()` and `buyAddon()` in `dashboard.html` check `clientRecord.billing_email`
   client-side before calling their respective checkout routes (and focus the field instead of
   proceeding if it's blank) — the Worker enforces the same rule server-side regardless, so this
   can't be bypassed by calling the API directly.
8. **Usage dashboard** — computed client-side from leads already loaded into the dashboard
   (`ConvHistory` entries with `role:'assistant'` this calendar month = messages sent, lead count
   this month = leads captured, terminal-stage ratio = conversion rate). No new tracking needed.

**Not yet verified against a live Stripe account**: the Checkout/Portal/webhook request shapes
follow Stripe's public API docs, but this hasn't been smoke-tested end-to-end — test the full
subscribe → webhook → portal → add-on loop with Stripe test-mode keys before going live.

### Payment status check & reconciliation (n8n/billing-reconcile.json)
A standalone n8n workflow, separate from both the Worker's webhook and `n8n/notifications.json`,
that runs every 6 hours and re-derives each billing-enabled client's status straight from Stripe
rather than trusting whatever the webhook last wrote. This exists because the webhook is the
**only** thing keeping NocoDB in sync today — if a delivery is delayed, dropped, or arrives out of
order (Stripe doesn't guarantee ordering), nothing currently notices or corrects it. This job is
that second line of defense.

Per client (skips anyone with no `stripe_customer_id` — i.e. anyone who's never started billing):
1. **Subscription drift** — pulls the customer's live Subscriptions from Stripe and corrects
   `plan_status`/`plan_renews_at`/`plan_cancel_at_period_end`/`plan_name`/`stripe_subscription_id`
   in NocoDB if they've drifted from what Stripe actually shows. If Stripe shows no subscription
   at all for a customer NocoDB still thinks is active, it's marked `canceled` — the most common
   real cause is a missed `customer.subscription.deleted` webhook.
2. **Billing email drift** — the Stripe Customer's email is always supposed to mirror the account's
   billing profile (`authentik_email`); this is treated as the single source of truth precisely
   *because* Stripe Checkout locks the email field once the Customer object already has one set
   (see `ensureStripeCustomer` in `worker.js`) — so a customer genuinely **cannot** change their
   billing email at payment time. If this job finds the two out of sync anyway, that only happens
   from an out-of-band edit (Stripe Dashboard, direct API call, or a legacy customer created before
   `authentik_email` existed) — it restores the Customer's email back to the billing profile rather
   than accepting the drift.
3. Whatever it corrects (if anything) is reported via the same `notification_email`/
   `slack_webhook_url` CLIENTS fields `n8n/notifications.json` already uses — no separate alerting
   config needed.

**Setup**: add a Header Auth credential named **Stripe secret key** (header `Authorization`, value
`Bearer sk_live_...`) — the Stripe secret key is deliberately *not* hardcoded inline in the JSON the
way the NocoDB master token is elsewhere in this repo, since a leaked Stripe secret key has a much
larger blast radius than a leaked self-hosted NocoDB token. Reuses the existing **SMTP Account**
credential from `notifications.json`. See the workflow's own README sticky note for more.

**Why this is a separate workflow and not folded into `notifications.json` or the Worker**: it has
a different trigger cadence (6h vs. 15min), a different failure domain (Stripe API, not
NocoDB/Chatwoot), and a different credential (Stripe secret key — a much higher-blast-radius secret
than anything else this repo's n8n workflows hold) — keeping it isolated means a bug in one
workflow's JS can't touch the other, and the credential only needs to be granted to the one
workflow that actually needs it.

## AI sales rep: sentiment/objection handling, deal forecast, team ops (engine.json + notifications.json)
Four additions on top of the original regex-only engine, aimed at closing the gap between
"scripted chatbot" and "AI sales rep":

**1. AI intent + sentiment classification** — `AI Agent · Sentiment & Intent` (a real
`@n8n/n8n-nodes-langchain.agent` node, not a raw HTTP call) sits between `Code · Intent prep` and
`Code · Intent classify`, backed by a `Google Gemini Chat Model` node
(`@n8n/n8n-nodes-langchain.lmChatGoogleGemini`, model `models/gemini-2.0-flash`) wired to it via the
`ai_languageModel` connection. It reads the latest message plus the last 4 turns and returns
`{intent, sentiment, confidence}`. The old regex ladder is kept as both a fast-path (a literal
"talk to a human" always wins instantly, free, with no LLM round-trip) and a fallback (if the agent
call fails, times out, or returns low confidence, regex still classifies the message — the bot
never goes silent because of an LLM outage). This means the engine now understands paraphrased,
sarcastic, or non-keyword phrasing the old pure-regex classifier couldn't. A `Sentiment` of
`Frustrated` force-escalates to human handover regardless of what stage the conversation is in — a
safety net the regex-only version had no way to express.

**Setup**: add a **Google Gemini(PaLM) Api** credential in n8n (Credentials → New → search
"Gemini") named **Google Gemini API** — just needs a Gemini API key from
[Google AI Studio](https://aistudio.google.com/apikey). Attach it to the `Google Gemini Chat Model`
node (replacing the `REPLACE_GEMINI_CRED` placeholder). No OpenRouter key needed for this
particular call — the rest of the engine's `openrouter_key`/`model` config is unaffected.

The same agent call also asks for `objection` (one of `none`/`price`/`competitor`/`timing`/`trust`)
and `win_probability` (0-100) in the same JSON response — one Gemini call covers intent, sentiment,
objection detection, and win-probability estimation together, feeding the objection-handling route
and the AI-driven win-probability logic described below (both already built to consume these exact
field names from whatever populates them).

**2. Objection handling** — when the classifier detects an objection (`price`/`competitor`/
`timing`/`trust`) on a message that would otherwise just get a generic FAQ answer, the engine
routes to a dedicated `Code · Objection prep → HTTP · Objection → Code · Objection reply` chain
instead. It grounds the response in the client's `objection_playbook` (see schema above) —
an approved response strategy per category — falling back to a generic "acknowledge honestly,
respond with confidence, always propose one concrete next step" instruction if the client hasn't
configured a playbook or hasn't covered that category. Toggle off entirely per client via
`bot_config.objection_handling_enabled: false` (same JSON blob as the existing `handover_enabled`/
`qual_enabled`/`antiloop_enabled` flags).

**3. Deal value & forecast** — `DealValue`/`DealCurrency` are dashboard-only fields (the bot has no
way to know a deal's size, so it never touches them). `WinProbability` is auto-suggested by the
engine every turn from stage progress + lead score (same inputs the existing `QualScore` heuristic
already used), capped and floored, and bumped to at least 55 on human handover — but stops
auto-updating the moment `WinProbabilityManual` is flipped to "Yes", so a rep's manual override is
never silently clobbered on the lead's next message. This gives pipeline $ value and a weighted
forecast (`Σ DealValue × WinProbability`) instead of just a stage count.

**4. Sales-team ops layer** — two pieces:
- **Round-robin owner assignment**: reuses the existing `agents` field (Settings → General → Agents
  — the same list that already populates the Owner dropdown) rather than adding a new column. If a
  client has agents configured, every newly created lead is auto-assigned an `Owner` from that
  list, deterministic by a hash of the phone number (not a shared counter) — spreads evenly with no
  race condition between concurrent webhook calls, at the cost of not being a perfectly even
  rotation for tiny agent lists. Existing leads and clients with no agents configured are
  unaffected — manual assignment still works exactly as before.
- **SLA + Slack alerting**: `n8n/notifications.json` (the existing 15-minute hot-lead/handover email
  poll) now also checks for leads sitting in `human_handover` longer than the client's `sla_minutes`
  (default 15) without a stage change, and alerts once per breach (`SlaAlerted` dedupe flag, reset
  whenever a lead re-enters handover). All three alert types (hot lead, handover, SLA breach) now
  also POST to `slack_webhook_url` if the client has set one, in addition to email — set up a Slack
  **Incoming Webhook** and paste its URL into that field, no other config needed. See the "Known
  limitation" note under the LEADS schema above for what the SLA check can and can't see.

## Sales models applied to the engine: deal health, proactive insight, urgency, predictive win %
Four more additions, each a minimal-effort application of a named sales model rather than new
infrastructure — all reuse nodes/fields already described above:

**1. Deal Health Score (MEDDIC/Gong-style)** — pure dashboard computation, no new schema, no engine
change. `dealHealth()` in `dashboard.html` combines `WinProbability`, `Sentiment`,
`LastObjectionCategory`, and days-since-last-message into one Green/"Healthy" · Yellow/"At risk" ·
Red/"Stalling" chip, shown on kanban cards, the leads list, and the lead detail panel. Skipped
entirely once a lead reaches a stage in the dashboard's existing `TERMINAL` set (already-decided
deals don't need a health score).

**2. Proactive commercial insight (Challenger Sale)** — one instruction added to the system prompt
in `Code · FAQ prep` / `Code · Travel FAQ prep` / `Code · Ecom FAQ prep`: if the lead has stated a
pain point earlier in the conversation, volunteer one relevant insight tied to it instead of only
answering the literal question. Self-limits to once per conversation by checking the "Recent
Conversation" block already in the same prompt — no new field, no new node.

**3. Time-boxed close offer on price objections (urgency/scarcity)** — `Code · Objection prep`
now adds an urgency instruction specifically for `price`-category objections, grounded in the
client's real `quote_validity_days` (now read into the ctx object alongside the other quotation
fields) when set — e.g. "this pricing is confirmed for the next N days." Deliberately instructed
**not** to invent a discount or deadline when `quote_validity_days` isn't configured, to avoid the
bot fabricating false urgency.

**4. Predictive win probability (Einstein/HubSpot-style predictive scoring)** — rather than
standing up a trained model (there isn't yet enough historical Converted/Lost volume for one to be
meaningful), `HTTP · AI Classify` now also asks the same LLM call for a `win_probability` (0-100)
estimate from conversation tone/urgency. `Code · Prep lead` uses it in place of the old pure
stage-progress heuristic whenever the AI gave a valid number, falling back to the heuristic if the
call failed — same "AI primary, rule-based fallback" pattern as the intent classifier. Still
respects `WinProbabilityManual`, so a rep's own edit is never overwritten. This can be swapped for
a real trained model later without changing anything downstream — `Code · Prep lead` only cares
that `sc.aiWinProbability` is a number.

## Revenue Forecast dashboard (`frontend/dashboard.html` — Team page)
Adds a trended view under 📊 Team Performance, next to the existing (snapshot-only) Funnel
Analytics: **Forecast vs. Actual by month**, **Win Rate Trend**, **Pipeline by Stage**, and a
**Pipeline Velocity** stat. Computed entirely client-side from `allLeads`, same pattern as Team
Performance/Funnel Analytics — no new backend route.

- **`ClosedAt`** (new LEADS column, see schema table above) is the piece that didn't already
  exist: nothing previously recorded *when* a deal actually closed, only its current `Stage`, so
  there was no way to bucket won/lost deals by month. Stamped once by `stampClosedAt()`, called
  from `reportLeadQualityChange()` — the single chokepoint every Stage-changing call site
  (`kbDrop` on the kanban, `saveLead()`, Human Deals' `removeHumanDeal()`) already routes through
  for Meta CAPI reporting. Fires only on the won/lost transition itself, never overwrites an
  existing value.
- **`isWonLead()`/`isLostLead()`** — the `Stage==='won'||'converted'||(TERMINAL-but-not-
  human_handover)` check used to be inlined separately in `renderTeamPerformance` and
  `generateReport`; factored into one function here since the forecast section needed it in three
  more places. `isLostLead` matches what Human Deals actually writes (`HD_OUTCOME_STAGE`'s
  `'Lost'->'lost'`).
- **Forecast vs. Actual (last 6 months)**: past months show only **Actual** (sum of `DealValue`
  for leads won that month, bucketed by `ClosedAt`, falling back to `Date` for leads closed before
  this shipped). Only the **current, still-open month** also shows a live **Forecast** figure — the
  weighted value (`DealValue × WinProbability`) of deals still active right now. This is
  deliberate, not a gap to fix later: nothing in this app snapshots pipeline state over time, so
  there's no honest way to reconstruct "what the forecast looked like in March" for a past month —
  only what actually closed by then.
- **Win Rate Trend**: resolved (won + lost) leads per month, `won / (won + lost)`, same `ClosedAt`
  bucketing.
- **Pipeline by Stage**: active (not yet won/lost) deal value per pipeline stage, same stage list
  the kanban already uses.
- **Pipeline Velocity**: the standard `(active deals × win rate × avg deal size) / avg sales cycle
  length` formula. Avg cycle length is `ClosedAt − Date` averaged over won leads that have both
  fields — leads won before `ClosedAt` existed are excluded from that average rather than guessed
  at, so the figure quietly gets more accurate as more deals close post-launch.
- **Team Performance's per-agent table** gained a **Win Rate (30d)** column next to the existing
  all-time Win Rate, scoped to each agent's leads resolved in the last 30 days via `ClosedAt` — a
  lightweight per-agent trend signal without building a full per-agent time-series matrix.
- **Not done here**: a true forecast-accuracy view (comparing what was predicted vs. what closed,
  month over month) would need periodic pipeline snapshots, which this app doesn't store anywhere
  — a deliberate scope cut, not an oversight.

## Data enrichment on capture (`cloudflare-worker/worker.js` + `frontend/dashboard.html`)
Auto-fills a couple of signals a WhatsApp-first lead otherwise arrives with zero information
about, beyond what the customer volunteers in conversation — scoped deliberately to what's
actually derivable for free, not fabricated.

- **Country, from the phone's calling code** — `phoneToCountry()` in `worker.js` is a deterministic
  E.164 calling-code table (no external API, no cost). Applied in `engineBuildLeadUpsertBody` for
  a brand-new lead only, and only if `Country` isn't already set — never overwrites a rep's manual
  edit or a blank left on purpose. NANP (`+1`) covers US/Canada/most Caribbean nations under one
  code with no shorter public prefix to split further, so it's labeled generically
  (`US/Canada/Caribbean (NANP)`) rather than guessed at.
  `dashboard.html` has its own smaller copy of the same table (`DASH_PHONE_COUNTRY_CODES`,
  `phoneToCountryClient()`) so a lead added by hand through the Add Lead modal gets the same
  enrichment an organic WhatsApp lead gets server-side — deliberately shorter (the regions this
  CRM's own clients actually operate in), since a wrong guess on an uncommon code is worse than
  leaving `Country` blank for a rep to fill in.
- **Company name/domain, from the lead's Email** — `companyFromEmail()` in `dashboard.html`,
  applied in `saveLead()` whenever an Email is entered and `CompanyDomain` isn't already set.
  Extracts the domain, excludes free personal-email providers (gmail/yahoo/outlook/etc. — those
  aren't a company), and title-cases the domain's first label as a `CompanyName` guess. The engine
  never does this itself since WhatsApp gives it no Email input at all — this only fires through
  the dashboard's own lead-editing path.
- **Known limitation, by design**: real firmographic data — employee count, funding, verified
  social profiles — needs a paid third-party enrichment API (Clearbit/Apollo/similar), which this
  app doesn't integrate. Deliberately not fabricated here (e.g. guessing a LinkedIn URL from a
  domain would be an unverified, often-wrong link); if that's wanted later, it's a new optional
  `enrichment_api_key`-style integration, same "no-op if unconfigured" shape as Meta CAPI/Resend,
  not an extension of the deterministic lookups above.

## Storage split: NocoDB vs. Cloudflare D1
Every module in this app reads/writes NocoDB — it's the system of record for the lead/client
record itself (Stage, DealValue, Name, Phone, ClosedAt, Country, CompanyName, etc.), and every
existing view (kanban, lead list, CSV export, B2B analytics, Team Performance) already reads leads
out of it. Four modules are the exception, each for the same reason: they invented data that no
other part of the app reads, so instead of adding more manually-created NocoDB columns/tables for
data nothing else needs, that data lives in **Cloudflare D1** (`env.DB`), a real SQL database bound
directly to the Worker, schema-versioned via `cloudflare-worker/migrations/*.sql` rather than
NocoDB's "add this field/table by hand in the UI" process:
- **Review Request module** (who was asked for a review, and when/whether they clicked) —
  `migrations/0001_reviews_referrals.sql`.
- **Referral tracking** (who referred whom, reward status) —
  `migrations/0001_reviews_referrals.sql`.
- **B2B Documents** (quotes/catalogs — everything *except* Brand/Country/`b2b_events`, which stay
  NocoDB LEADS columns since existing lead views already read those) —
  `migrations/0002_accounting_b2b_documents.sql`.
- **Accounting Documents** (Quotation/Invoice/Receipt + ERPNext sync state, plus the optional
  `erpnext_customer`/`company`/`erpnext_debtors_account` links) —
  `migrations/0002_accounting_b2b_documents.sql`, `migrations/0004_accounting_erpnext_customer.sql`
  and `migrations/0005_accounting_company_debtors.sql`.
- **Meta CAPI event log** (an audit trail of events actually sent to Meta, for the Meta Ads ROI
  Report's own use — not a NocoDB replacement for anything, just new data that never existed
  before) — `migrations/0003_meta_capi_log.sql`.
- **Follow-up Engine** (A/B message variants for the classic follow-up sequence, plus the resulting
  send/reply log) — `migrations/0007_followup_engine.sql`.
- **Human Deals Coach panel** (a per-turn Sentiment/LastObjectionCategory log — the Leads row only
  ever keeps the latest value, never a history) — `migrations/0008_coach_signals.sql`.
- **Hospitality module** (units, blocked dates, rate overrides, and bookings for the houseboat/
  hotel/tourism-stay module — a whole new module's data, not sidecar fields on an existing NocoDB
  record, though a booking can still optionally link back to a NocoDB lead via `lead_id`) —
  `migrations/0009_hospitality.sql`. Its unit photos/video (`migrations/0010_hospitality_media.sql`)
  columns just hold a pasted Google Drive share link now (see "Unit photos/video" above) — D1 only
  holds that URL string, same as everywhere else in this list holds text/JSON. Cloudflare R2
  (`HOSPITALITY_MEDIA` binding) is still there and still readable, kept only for units that already
  had a file uploaded before the switch to Drive links.
- **Real Estate module** (projects, tower/floor/unit inventory with hold-expiry, site visits,
  bookings, payment milestones, post-sales tickets, channel partners, commissions, the RERA
  document repository, and the price-change audit trail — again a whole new module's data, though
  leads/bookings can still link back to a NocoDB lead via `lead_id`) —
  `migrations/0031_real_estate.sql`. Lead-side fields (source, project interest, budget, urgency,
  zone, language, score, investor flag) stay plain NocoDB LEADS columns instead, same reasoning as
  B2B's Brand/Country above.

All nine still read Stage/DealValue/ClosedAt/Name/Phone/etc. straight out of NocoDB wherever they
need it — D1 only holds what's genuinely new, and every route that moved keeps its exact pre-D1
request/response shape, so no frontend page needed to change for this migration.

**One-time setup** (`cloudflare-worker/wrangler.toml`):
1. `wrangler d1 create leadvyne-d1`
2. Paste the returned `database_id` into the `[[d1_databases]]` block in `wrangler.toml`.
3. `wrangler d1 migrations apply leadvyne-d1 --remote` (applies every migration file in
   `cloudflare-worker/migrations/` in order — running it again after adding a new migration file
   only applies what's new).

## Review Request module (`frontend/broadcast.html` — "⭐ Reviews" tab, `cloudflare-worker/worker.js`)
Automated "ask for a review N days after a deal closes" — a dedicated module, not built on top of
the generic Automations engine above: a client would otherwise have to hand-build a flow
(trigger=`stage_enter`, one `wait` step, one `send_whatsapp_dm` step) with no click-through
visibility at all, since a plain flow message has no tracked link. This module adds exactly that.

- **Schema** (D1, `review_config`/`review_requests` — see `migrations/0001_reviews_referrals.sql`):
  `review_config` is one row per client (enabled toggle, the Stage names that count as "completed,"
  delay hours, message template). `review_requests` is one row per lead a request has ever been
  sent to — `lead_id` is its own primary key, since "has this lead already been asked" is the only
  lookup this table needs.
- **Trigger signal**: reuses `ClosedAt` from NocoDB (added for the Revenue Forecast dashboard
  above — "when did this deal actually finish"). The Stage names that count as "completed" are a
  client's own choice (`review_config.stages_json`), since Stage names are freeform per client via
  the stage builder.
- **Backend** (`worker.js`): `sweepReviewRequests` is a Cron Trigger entry point, piggybacked on
  the same `*/15 * * * *` tick as `runAutomationFlowsForAllClients` (a multi-hour/day delay doesn't
  need its own finer-grained schedule — see `wrangler.toml`). Reads D1's `review_config` directly
  for the list of enabled clients (cheaper than the full NocoDB CLIENTS scan an earlier revision of
  this module needed), then for each: fetches the leads matching its Stage/`ClosedAt` criteria from
  NocoDB, filters out anyone already in `review_requests` (one D1 query per client, not one per
  lead), sends via `sendFlowWhatsappDm` (the same Chatwoot call shape Automations uses), and inserts
  the `review_requests` row so it only ever sends once.
- **Click tracking**: the link sent is `{WORKER_BASE_URL}/reviews/click?lead_id=&token=`, where
  `token` is `hmacHex(env, 'review:'+leadId)` — the same HMAC-signed-link pattern
  `handleEmailUnsubscribe` already uses for its own unsubscribe link. `handleReviewClick` verifies
  the token (constant-time compare), reads `client_id` straight off the D1 row (no NocoDB lead
  lookup needed for that), stamps `clicked_at` once, then 302-redirects to the client's own
  `review_link` (still a NocoDB CLIENTS field, shared with other modules — not moved) — so
  click-through is measurable without depending on the destination review platform's own
  analytics.
- **Frontend** (`broadcast.html`): "⭐ Reviews" tab — enable toggle, a Stage multi-select (reusing
  the same `seg-chip` pattern as the Automations flow editor's audience picker), delay hours,
  message template, and a stats card (Requests Sent / Clicked Through / Click Rate) fetched from
  `GET /reviews/stats` (a D1 count query) — no longer computed by filtering `allLeads`, since this
  data isn't on the lead record at all.
- **Config routes** (`GET/POST /reviews/config`, session-gated) read/write `review_config` via a
  SQLite `INSERT ... ON CONFLICT DO UPDATE` upsert.
- Sends are skipped entirely if the client has no `review_link` set (Settings → General → Trust
  Signals) or no Chatwoot connected — this is best-effort secondary outreach, never a hard
  dependency for anything else in the CRM.

## Referral/affiliate tracking (`cloudflare-worker/worker.js` + `frontend/dashboard.html`)
Attributes a new lead to an existing customer's referral, via a `wa.me` deep link that pre-fills
the referred friend's very first WhatsApp message with the referrer's own code — no landing page,
no separate URL capture needed, since this app is WhatsApp-first and most leads never touch a web
page at all.

- **Schema** (D1, `referral_codes`/`referrals` — see `migrations/0001_reviews_referrals.sql`):
  `referral_codes` is one row per lead that has ever generated a shareable code (`lead_id` primary
  key, never regenerated). `referrals` is one row per successful referral event —
  `referred_lead_id` is UNIQUE (a lead can only ever be credited to the first code that referred
  them in), and `reward_status` lives per referral event, not per referrer, so a referrer who
  brings in five people can have each one individually marked rewarded. `ReferralCount` isn't a
  stored counter at all — it's `COUNT(*) FROM referrals WHERE referrer_lead_id=?`, computed on
  read, which also sidesteps the increment-race a stored counter would need to guard against.
- **Get Referral Link** (lead detail pane, `dashboard.html`): `POST /referrals/generate-code`
  creates a short random code (retrying up to 5 times on the rare `UNIQUE(client_id, code)`
  collision) the first time it's requested for a given lead — never regenerated after that, so
  re-sharing the same link keeps attributing new signups to the same person. The dashboard builds
  `https://wa.me/<business WhatsApp number>?text=REF-<code>` from `clientRecord.wa_display_phone`;
  refuses to generate one (with an explanatory alert) if WhatsApp isn't connected yet, since
  there'd be no number to build the link from.
- **Detection** (`worker.js`, `engineDetectReferral`): checked only for a brand-new lead's very
  first message (an existing lead re-typing an old code by accident shouldn't re-attribute them),
  matched against a `REF-XXXXXX` pattern and resolved to a referrer lead id via one D1 query scoped
  to this same client (a code only needs to be unique per client — two different clients'
  customers could coincidentally share one). This is a pure D1 lookup with **no NocoDB round-trip
  at detection time** — D1 only needs to resolve an id, not the referrer's Name/Phone, which the
  dashboard fetches lazily and separately only when someone actually opens a lead's detail pane
  (`GET /referrals/lead-info`, one batched NocoDB fetch for whichever names that response needs).
  On a match, the code is stripped from the text before it ever reaches intent classification or
  the AI reply, so it never shows up in `ConvHistory` or confuses the conversation. The actual
  `referrals` row is written once `engineUpsertLead` resolves the brand-new lead's real id
  (`INSERT OR IGNORE`, so a Chatwoot webhook redelivery replaying the same turn can't double-insert
  the same referral — the `UNIQUE(referred_lead_id)` index is what makes that safe).
- **Reward tracking**: a lead with a `referred_by` entry shows a "Mark Rewarded" button in its
  detail pane (`POST /referrals/reward`, toggling that referral's `reward_status` between
  `Pending`/`Rewarded`). Actual reward fulfillment (a discount code, a payout) is a manual business
  process outside this app — this only tracks whether it's been done, the same "flag it, a human
  completes the loop" shape as the Review module's click tracking above.
- **Ownership check**: all three dashboard routes (`lead-info`/`generate-code`/`reward`) verify the
  requested `lead_id` actually belongs to the session's client (`engineLeadBelongsToClient`, one
  NocoDB fetch) before touching D1 — D1 has no foreign key into NocoDB to enforce that itself, and
  `lead_id` here comes from the request, not the trusted session.
- **Known limitation**: there's no leaderboard/top-referrers view built here — a lead's own detail
  pane shows how many people *that* lead has referred, but a dedicated ranked view across all
  leads would be a natural, separate follow-up.

## Campaigns module (frontend/broadcast.html — renamed from "Broadcast")
Reworked in two ways: migrated off the master-NocoDB-token/plaintext-password pattern onto the
same Worker-session architecture as `dashboard.html`, and reorganized from 3 tabs into 5, adding
Follow-ups and Tracking.

**Security migration**: this page used to embed the master NocoDB token *and* the client's own
`chatwoot_token` directly in the page source (view-source readable) — the exact vulnerability
already fixed in `dashboard.html` via Authentik + the Worker (see "Dashboard login" above), just
never carried over here. Fixed the same way:
- No more standalone login form. This page only ever opens via `window.open('broadcast.html',
  '_blank')` from an already-authenticated `dashboard.html` tab, which — per the same-origin
  `window.open` spec behavior — copies its `sessionStorage` into the new tab, so `lv_cid`/
  `lv_session` are already present. If they're missing (e.g. someone bookmarks this page directly),
  it just redirects to `dashboard.html` to sign in there.
- All NocoDB reads/writes now go through `${WORKER_BASE}/nocodb/*` with the inherited session
  bearer token, same as `dashboard.html`.
- Every Chatwoot call (DM send, follow-up send) moved server-side into the Worker — routes `POST
  /broadcast/send-dm`, `POST /broadcast/followup-send` — so `chatwoot_token` never reaches the
  browser. Both look up a lead's conversation ID via the same fallback chain as `dashboard.html`'s
  `leadConvId()` (`ConversationID`/`conv_id`/`ConversationId`/`chatwoot_conv_id`) since leads have
  been written under inconsistent field casings depending on the write path — checking only
  `ConversationID` silently sent a blank ID to Chatwoot on some leads.
- **Template Broadcast and Manage Templates both list/send through Chatwoot** (`GET/POST
  /broadcast/templates`, `POST /broadcast/send-template`), using only the client's existing
  `chatwoot_token`/`chatwoot_inbox_id` — no separate Meta Embedded Signup connection required just
  to browse or send an already-approved template. This used to require `wa_phone_id`/`wa_token`
  (Template Broadcast) or hit a Chatwoot route that doesn't actually exist (Manage Templates),
  producing the exact bug report "WhatsApp already connected in Chatwoot, still says to connect
  WhatsApp" / "404 Chatwoot error" — see the note below on the real Chatwoot API shape.
  - **The real Chatwoot API has no `whatsapp_templates` sub-resource at all** — that route 404s on
    every inbox, always (confirmed directly against Chatwoot's own open-source `routes.rb`/
    controller/model/jbuilder view). The actual shape: `POST .../inboxes/:id/sync_templates` is
    *asynchronous* — it only enqueues a background job that pulls the latest approved templates
    from Meta and returns `{message: 'Template sync initiated successfully'}` immediately, no
    templates in the response. The synced list itself lives in a `message_templates` field on the
    *plain* inbox-show response, `GET .../inboxes/:id`. `handleBroadcastTemplatesGet` now reads
    that field; `POST /broadcast/templates/sync` triggers the async sync; `broadcast.html`'s
    `refreshTemplates()` fires the sync, waits ~3s, then re-fetches, since a single immediate
    re-fetch after sync usually still shows the stale list.
  - **Creating a new template is the one operation that genuinely still needs Meta credentials** —
    Chatwoot's API only *syncs* templates that already exist on Meta; it has no create-template
    endpoint at all. `POST /broadcast/templates` (Manage Templates tab) submits straight to Meta's
    Graph API (`waba_id`/`wa_token`, same credentials the Channels module's Embedded Signup flow
    already collects) and returns a clear "connect Meta / create it in Business Manager, then
    Refresh" message if those aren't set — never a raw 404/502 from a nonexistent Chatwoot call.

**Template Broadcast: cold-lead fallback** — Chatwoot's send path (`POST .../conversations/
{conv_id}/messages`) needs an *existing* conversation, so a lead with no `conv_id` — most commonly
a bulk Google Sheet import that's never messaged in — used to just fail with "no conversation ID"
for every single recipient, even though an **approved template is specifically designed to reach a
customer cold** (that's the whole reason Meta requires template approval for messages outside the
24h session window, unlike a plain session message). `sendTemplateBroadcast()` now checks
`leadConvId(lead)` first: if it's missing but the account has `wa_phone_id` set (Meta's direct
WhatsApp Cloud API, connected via Settings → Channels Embedded Signup — a non-secret id, safe to
branch on client-side) and the lead has a `Phone`, it sends straight through Meta's Graph API
instead (`POST /wa/send-template`, `handleWaSendTemplate` in `worker.js` — this route already
existed, used elsewhere, but was never wired into Template Broadcast's own send loop until now).
Meta's send API wants a native `components:[{type:'body', parameters:[{type:'text', text:...}]}]`
shape, not Chatwoot's flat `processed_params` map, so this path builds that separately from the
existing Chatwoot-bound `processed_params`/`content` substitution just below it in the same
function — the two sends are structurally different API calls, not just a different transport for
the same payload. A cold lead with a connected WhatsApp API sends normally (logged "sent directly
(no prior conversation)"); a cold lead with **no** WhatsApp API connected still fails, but now says
so clearly ("connect WhatsApp Business API in Settings → Channels to reach cold leads like this")
instead of a generic "no conversation ID" that gave no indication anything could be done about it.
Every lead that already has a conversation is completely unaffected — same Chatwoot path as before.

**New tab: 🔁 Follow-ups** — shows leads currently mid-sequence in either of the two existing
automated systems: the classic `followup_messages` sequence (`Follow up 1/2/3` flags, up to
`followup_count` steps) and the recovery ladder (`recovery_stage`/`recovery_done`, driven by
`backend/recovery.js`). A "Send Next Now" button gives a rep a manual override — **classic
sequence only**; the recovery ladder is shown read-only since it's a separate automation with its
own escalation timing that a one-off manual send would desync. New Worker route: `POST
/broadcast/followup-send` (`{lead_id}`) — sends the next unconfigured classic step via Chatwoot
and marks the corresponding `Follow up N` field. Shares its actual send logic with the automated
cron below it (`sendClassicFollowupStep`) rather than a copy of it.

### Automated classic follow-up sends — migrated off n8n into a native Worker cron
The classic sequence's *automatic* sends (no rep click needed) used to exist only as an external
n8n workflow (`followup-template.json`, a separate repo out of this codebase's scope) that read
`followup_messages` straight off the Clients table with **zero awareness of the Follow-up Engine's
A/B variants** — so a client's carefully-configured variant content only ever reached the manual
"Send Next Now" button above, never the actual scheduled sends most follow-ups go out through.
`runClassicFollowupsForAllClients` (`cloudflare-worker/worker.js`) replaces that workflow natively:
- Runs on the existing `*/15 * * * *` Worker tick (alongside Automations & Flow/`sweepReviewRequests`
  — see `scheduled()`), not the daily one, since `followup_hours` is commonly sub-daily (e.g.
  `"6,24,48"`). Scans `CLIENTS`, skipping any client with `followup_count<=0` or no Chatwoot
  connection, so a client who never configured the classic sequence is never touched.
- `followup_hours` is read as **cumulative hours-of-silence-since-`LastMsgAt`** thresholds — step N
  fires once a lead has been silent for at least `hours[N-1]` — the same "single fixed anchor,
  elapsed-time-to-step lookup" model `pipelineFollowupTargetStep`'s own cadence already uses in
  this file, rather than chaining each step off the previous step's send time.
- Skips terminal-stage (`PIPELINE_TERMINAL_STAGES` — the same "won-ish"/"closed-ish" set the
  Advanced Pipeline cadence uses), opted-out, and human-handover leads, same guards as everywhere
  else follow-ups get sent automatically.
- Both this cron and the manual "Send Next Now" route now call the same
  `sendClassicFollowupStep(env, c, lead, nextIdx, tmpl)` — which itself calls `pickFollowupVariant`
  first — so the Follow-up Engine's A/B content is the primary content for a classic follow-up
  **everywhere it can go out**, not just when a rep clicks a button.

**Required manual step**: if the old n8n `followup-template.json` workflow is still active for any
client, **deactivate it** now that this Worker sends the classic sequence natively. Leaving both
running won't double-send the exact same step (both check the same `Follow up N` flag before
sending), but n8n's copy still has no idea the Follow-up Engine exists — if its tick happens to
win the race for a given step, that occurrence goes out with the plain fallback text instead of the
configured A/B variant, which is exactly the gap this migration closes. There's no way to disable
the n8n workflow from this repo — it has to be turned off in n8n itself.

**New tab: 💪 Follow-up Engine** — makes the classic follow-up sequence's messages themselves
stronger, without changing *when* a step fires (`followup_count`/`followup_hours` in Settings
still decide that entirely). Storage: two new D1 tables
(`migrations/0007_followup_engine.sql`, `env.DB`) — `followup_variants`
(`client_id, step, variant('A'|'B'), message, cta, incentive_text, incentive_expires_hours,
social_proof, active`, unique on `(client_id, step, variant)`) and `followup_sends` (one row per
actual send: `client_id, lead_id, step, variant, sent_at, replied_at`).
- **A/B testing** — a step can have up to two message variants; `pickFollowupVariant()`
  (`handleBroadcastFollowupSend`'s helper) picks between an active, non-blank A and B 50/50 per
  send (not per lead — the same lead can get either variant on different steps). A client with no
  variants configured for a step falls straight back to the plain `followup_messages` text exactly
  as before — this is purely additive, never a required setup step.
- **Time-limited incentive shown only to droppers** — an optional `incentive_text` +
  `incentive_expires_hours` per variant, appended to the message as `⏳ {incentive_text} — offer
  expires in {N}h.`. No separate "is this a fresh lead" check exists or is needed: this whole send
  path (`handleBroadcastFollowupSend`) only exists because a lead already went quiet long enough to
  need a follow-up, so a still-engaged fresh lead structurally never reaches it.
- **Social proof at the drop-off point** — an optional per-variant toggle appends a real count:
  "`{N} customer(s) closed with us in the last 7 days`", computed server-side by
  `computeFollowupSocialProofCount()` — a Worker-side port of `dashboard.html`'s
  `getRecentBookingsCount()` (same "won-ish" stage set — `won`/`converted`/`consultation_booked`/
  `visit_booked`/`appt_booked` — same 7-day window, same "lead's own `Date` as a conversion-time
  proxy" caveat, since the Worker has no access to the browser's `allLeads`).
- **Continuous A/B stats** — `GET /followups/stats` groups `followup_sends` by `(step, variant)`
  and computes a reply rate. "Replied" is stamped the moment a lead who has any unresolved
  (`replied_at IS NULL`) follow-up send later sends any real inbound message at all
  (`handleEngineWebhook`, right after the lead upsert) — not scoped to a stage change, so a
  same-stage reply still counts. Sends made before any variant existed for that step log under a
  synthetic `'legacy'` variant, so the new system's performance can be compared against the old
  plain-text baseline.
- **Config UI**: `GET`/`POST /followups/variants` (`handleFollowupVariantsList`/
  `handleFollowupVariantsSave`), a full 3-step × 2-variant grid always returned/saved in one call —
  same "bulk save, not per-field" pattern the rest of this app's config screens use.

**New tab: 📊 Tracking** — every Direct Message / Template Broadcast / manual follow-up run gets
logged to a new CLIENTS field, `broadcast_log` (Long text, JSON array of `{ts, type, total, sent,
failed}`, capped to the most recent 50 — same capped-list pattern as `fulfilled_addon_events`).
Read/written via the existing generic `/nocodb/*` passthrough, no dedicated Worker route needed for
it. Add this column to the CLIENTS table before using the Tracking tab.

## Task manager (frontend/dashboard.html — Tasks page)
Reworked from three static, un-actionable read-only cards (Reminders Due Today / Hot Moments /
Overdue Follow-ups — no way to mark anything done, no manual tasks, no assignment) into one merged,
filterable, sortable worklist with ad-hoc task creation.

**Data model** — one new CLIENTS field, `manual_tasks` (Long Text), holding a single JSON object:
`{ items: [...], dismissed: [...] }`. No new NocoDB table — reuses the same capped-JSON-array-on-
CLIENTS pattern as `broadcast_log`, since task volume for a single account doesn't need a dedicated
table. Add this column to the CLIENTS table before using the Tasks page.
- `items`: manual (ad-hoc) tasks — `{id, title, notes, due_date, due_time, lead_id, lead_name,
  assignee_email, category, project_id, status: 'open'|'in_progress'|'done', created_at,
  completed_at}`. Capped on save: all open/in-progress items kept, done items capped to the most
  recent 100.
- `dismissed`: dismiss keys for auto-derived ("virtual") tasks the user clicked "✓ Done" on, e.g.
  `remind:123:2026-07-10` or `hot:55:<hot moment text>`. Keying on the specific field value (not
  just the lead ID) means dismissing one reminder doesn't hide a *later* reminder on the same lead —
  a new `ReminderDate`/`HotMomentText`/message on that lead produces a new key and reappears
  automatically. Capped to the most recent 300.
- `projects`: `{id, name, color, created_at}` — lightweight named groupings, no separate table,
  referenced by a manual task's `project_id`. Deleting a project unlinks its tasks rather than
  deleting them.

**Categories & Projects** — `category` is a fixed palette (`TASK_CATEGORIES` in dashboard.html:
Sales, Follow-up, Admin, Support, Marketing, Internal), each with a consistent tag color reused
everywhere it renders (list rows, project groups, board cards). Virtual tasks are auto-tagged for
free (Reminder/Overdue → Follow-up, Hot Moment → Sales) so category filtering works immediately
without touching a single manual task. Projects are created via a "+ New Project" prompt — either
blank, or from one of a few starter templates (`PROJECT_TEMPLATES`: New Client Onboarding, Deal
Close Push, Campaign Launch) that pre-populate a standard checklist as ordinary manual tasks
(no special linkage back to the template after creation).

### All Notes (Tasks page — 📝 Notes sub-tab)
A dedicated page inside Task Manager that aggregates every free-text notes field already
scattered across the app into one browsable, searchable list — Leads' notes, manual tasks' own
notes, and whichever industry module a client has active. Added a `📋 List`/`📝 Notes` sub-nav to
the Tasks page (same `.hosp-tab`/`data-*` sub-nav convention as Hospitality/Reports, scoped to
`#tasksSubNav` so its click listener doesn't collide with those modules' own page-wide ones) —
the existing Tasks list (`renderTasks()`) is now the "List" tab, unchanged and still kept fresh by
`loadAll()` on its usual 60s timer regardless of which sub-tab is showing.

- **`computeAllNotes()`** (dashboard.html) — pure in-memory aggregation, no new backend route,
  same "reuse already-loaded data" approach `computeAllTasks()` itself already uses for its
  virtual-task sources:
  - **Leads' `NotesList`** (the real append-only notes timeline — see `renderDetailNotes()`/
    `addNote()`) and **manual tasks' own `notes` field** are always complete, since `allLeads` and
    `manual_tasks` both load unconditionally at boot.
  - **Every other module's per-entity `notes`/`remarks` field** — Hospitality bookings
    (`hospBookings`), Appointments (`_apptBookings`), Recruit jobs/candidates (incl.
    `resume_notes`)/placements (`_rcJobs`/`_rcCandidates`/`_rcPlacements`), and Travel Agency incl.
    its Car Rental sub-module (`_taPackages`/`_taBookings`/`_taCases`/`_taItineraries`/
    `_taUmrahGroups`/`_taCars`/`_taCarBookings`/`_taGroupFares`/`_taSpecialFares`) — only appear
    once that module's own page has been visited this session, since each one lazy-loads its own
    array only on `navigate()`. A client's notes from a module they haven't opened yet simply
    won't show here until they do (visiting the tab once is enough — no reload needed); an
    accepted, honestly-scoped limitation rather than adding a fresh fetch per module just for
    this page.
  - `entityLabel` falls back generically across several common name fields (`name`/`client_name`/
    `customer_name`/`guest_name`/`candidate_name`/`title`) rather than one exact field per entity
    type — chasing the precise field name across a dozen entity shapes isn't worth it for a
    fallback label; worst case shows the generic source label instead of a real name, never a
    crash or a blank entry.
- **Click-through**: a Lead or Task note jumps straight to that lead's detail pane
  (`openDetail()`) or that task's modal (`openTaskModal()`); every other module's note navigates
  to that module's own tab (`navigate('hospitality'|'appointments'|'recruit'|'agency')`) rather
  than deep-linking the exact record's own edit modal — the dozen entity types across Recruit/
  Travel Agency don't share one consistent "open by id" function name, so this stays a safe,
  always-correct simplification instead of guessing.
- **Filter/search**: a source chip row (`All (N)`, `Lead (N)`, `Task (N)`, …) plus a text search
  matching note content or entity label, both computed client-side over `computeAllNotes()`'s
  output — no server round-trip.

### Stage-gated workflow engine (dependencies, auto-unlock, notifications, AI client summaries)
Projects/tasks amended in place to also work as a stage-gated delivery workflow — no new NocoDB
table or column; everything below still lives inside the same `manual_tasks` field described above.
A project used as a plain todo list (no client email, no dependencies) behaves exactly as before —
every piece here is opt-in per field.
- **Project gains**: `client_name`, `client_email`, `ai_summary_enabled` (default `true`) — set via
  a new "⚙️" button on each project's group header in the Projects view (`openProjectModal()`/
  `saveProjectFromModal()`), not the "+ New Project" prompt (which still only asks for a name).
- **Task/stage gains**: `depends_on` (array of other task ids in the *same* project — cross-project
  dependencies aren't meaningful, since the auto-unlock check only ever looks at siblings sharing a
  `project_id`) and `notify_customer` (boolean). Both editable in the existing task modal, scoped to
  whichever project is currently selected in that modal (`taskDepsPopulate()`, re-run on project
  change).
- **`blocked` is a new task status**, alongside the existing `open`/`in_progress`/`done` — reachable
  from a new fourth column on the Board view, or the "🚧 Block"/"↩ Unblock" buttons there.
- **"Locked" is computed, never stored** — `isStageLocked(task, state)` checks whether every id in
  `depends_on` currently has `status==='done'` in the same project's task list (supports fan-in: a
  stage waiting on two dependencies doesn't unlock until *both* are done). Because it's derived
  fresh every render rather than a persisted flag, it can't drift out of sync with the actual
  dependency graph. `computeAllTasks()` attaches the resolved boolean as `locked` on every task it
  returns; UI code should read `t.locked` directly rather than re-calling `isStageLocked()` against
  the flattened task shape `computeAllTasks()` produces, which doesn't carry `depends_on` through
  (a bug caught and fixed during testing — `renderTasksBoard()` was recomputing against the wrong
  object shape and always getting `false`). A locked task's Start/Block/Done buttons are hidden
  (Board) or replaced with a "🔒 Locked" label (List); only "Edit" stays available.
- **Notifications, all via the existing `/tasks/notify` Worker route** (fixed
  title/notes/due_date/due_time/lead_name email template, already used for assignee-notify-on-save
  — no backend changes needed for any of the below, just new call sites):
  - **Auto-unlock**: `notifyDependentsIfUnlocked()` — when a stage is marked `done`, finds sibling
    stages whose `depends_on` includes it and are now fully unlocked (respects fan-in), and emails
    each one's `assignee_email`.
  - **Blocked alert**: `notifyProjectOwnerBlocked()` — fires only to `clientRecord.authentik_email`
    (the account owner), **never** the customer, when a stage is marked `blocked`.
  - **Client-facing update**: `notifyClientIfStageComplete()` — fires only when the completed
    stage has `notify_customer` checked *and* its project has a `client_email` set; a plain
    todo-list project with neither configured never emails anyone new.
  - Both `moveTaskStatus()` (Board) and `toggleTaskDone()` (List — now delegates to
    `moveTaskStatus()` instead of duplicating the save) funnel through the same status-change path,
    so notifications fire identically regardless of which view triggered the transition.
- **AI client summary — deliberately a low-cost OpenRouter model, not this app's usual
  `google/gemini-2.5-flash` default.** `notifyClientIfStageComplete()` calls the existing
  `/ai/complete` route (which already lets the *caller* override the model per-request) with
  `model:'google/gemini-2.5-flash-lite'` — a cheaper/faster tier in the same family already proven
  elsewhere in this codebase, appropriate since rewriting one internal note into a short
  client-facing paragraph is a low-complexity task that doesn't need a frontier model. Falls back
  to the raw stage notes verbatim if `ai_summary_enabled` is off, there are no notes to rewrite, or
  the AI call itself fails — a rougher client email beats silently sending nothing. **Not
  live-verified**: this session's network policy blocked OpenRouter's own site, so the exact
  current price/availability of this model slug should be checked on OpenRouter's model page before
  relying on it in production, same caveat as the Sarvam TTS integration elsewhere in this file.
- **Notification log** (`state.notificationLog`) — every send attempt (success or failure) is
  appended with `{ts, to, type, subject, channel, ok, error}`, capped at 200 entries the same way
  `dismissed`/done-items already are. Viewable via the new "🔔 Notification Log" button on the
  Tasks page (`openNotifyLogModal()`) — the "who was notified, when, what channel" audit trail, for
  dispute resolution. A dedicated NocoDB table would scale better long-term if log volume grows
  large, but wasn't necessary to ship this.
- **AI-suggested stage sequencing was later added** (see "AI auto-stage creation" below) as a
  per-completion suggestion, not historical-project-similarity matching — `PROJECT_TEMPLATES` still
  covers "start from a known-good sequence for a project type" up front; real similarity-matching
  against project history remains unbuilt, worth it only once there's enough real history to match
  against.

### AI auto-stage creation, Project detail view, Calendar view
Three more additions on top of the workflow engine above, all opt-in.
- **AI auto-stage creation** (`ai_auto_stage_enabled`, new project setting, **off by default**) —
  when a stage completes, `maybeAiCreateNextStage()` checks whether anything already depends on it
  (a manually-planned chain is never overridden by an AI guess); if not, `aiSuggestNextStage()`
  calls `/ai/complete` with the same low-cost `google/gemini-2.5-flash-lite` model, passing the
  project's stage history and the real team email list. The model may suggest a title/notes/owner,
  or explicitly decide there's no sensible next stage. **The owner is only ever a real team
  member** — a suggested `owner_email` is checked against `getTeamMembers()` and dropped (left
  unassigned) if it doesn't match, never trusted as-is. The new stage depends on the one that just
  completed, so it's unlocked immediately — "auto-notify and move on" is simply sending that
  owner the same unlock email a manually-created dependent stage would have gotten, right after
  creating it. Stages created this way are tagged `ai_created:true` (shown as a ✨ in the UI) so
  it's always visible which stages a human planned vs. which the AI proposed.
- **Simple Project → Sub-tasks view** (`openProjectDetail()`/`renderProjectDetail()`, new
  `TASK_VIEW==='detail'`) — clicking a project's name (or its new "📋 View" button) in the Projects
  view drills into a focused single-project page: one-line stage cards (`oneLineStageCard()` —
  status icon, title, owner, due date, all on one row, click to edit), a "+ Add Stage" button
  pre-scoped to that project (`openTaskModalForProject()`, which just calls `openTaskModal()` with
  a new third `prefillProjectId` argument), and a "⚙️ Settings" shortcut back to the project modal.
  Locked stages render dimmed with a 🔒 in place of the status icon, same convention as the Board.
- **Project Calendar view** (`TASK_VIEW==='calendar'`, `renderTasksCalendar()`) — a hand-built
  month grid (no calendar library pulled in; nothing else in this app needed one either) plotting
  every manual task/stage by `due_date`, up to 3 per day plus a "+N more" overflow count, Prev/
  Next/Today navigation. Locked stages show a 🔒 prefix. Same `TASK_PROJECT_FILTER`/category
  filters as every other view narrow it down. Completed tasks don't appear here, same as every
  other view — `computeAllTasks()` excludes `status==='done'` items application-wide, not something
  this view special-cases.

**Three views** (toggle in the secondary control row): **List** (the original unified sorted view,
now with category/project tags), **Projects** (grouped by `project_id`, each group showing a
progress bar computed from *all* of that project's tasks including done ones, not just the open
ones the list itself shows — virtual tasks and unassigned manual tasks fall into a "No Project"
group), and **Board** (a 3-column To Do / In Progress / Done kanban, **manual tasks only** — the
open→dismissed lifecycle of auto-derived reminders/hot-moments/overdue items doesn't map onto a
kanban's start/finish flow, so those never appear here). Board is the only place a task can be
`in_progress`; the quick "✓ Done" button elsewhere just toggles open↔done directly.

**Unified list** (`computeAllTasks()` in dashboard.html) — merges virtual tasks (recomputed fresh
from `allLeads` every render, exactly as the old three cards did) with stored manual tasks, sorted
by a single urgency score across all types, with filter tabs: All / Due Today / Hot / Overdue /
Manual / Mine. A live badge (red dot on mobile, red count on desktop) appears on the Tasks nav item
whenever due-today + hot + overdue items exist, updated from `renderHome()` so it's fresh even when
Tasks isn't the active page.

**Per-item actions**: ✓ Done (marks a manual task done, or dismisses a virtual one), +1d snooze
(bumps a lead's `ReminderDate`, or a manual task's `due_date`), Edit (manual tasks only), and — if
linked to a lead — 💬 WA Follow-up, which reuses the exact same `POST /broadcast/followup-send`
Worker route the Campaigns Follow-ups tab uses, so a stalled lead can be nudged without leaving
Tasks.

**Email notifications** — creating/editing a task offers an assignee (from `team_emails` +
`authentik_email` — the same real, verified addresses used for team login, not the plain
`agents` name list used for lead-Owner assignment, which has no emails) and a "notify by email"
checkbox. Sends via a new best-effort Worker route, `POST /tasks/notify`, using
[Resend](https://resend.com)'s REST API directly (`fetch`, no SDK). Requires two new Worker env
vars: `RESEND_API_KEY` and optionally `RESEND_FROM_EMAIL` (defaults to
`Leadvyne Tasks <tasks@leadvyne.com>` — set this to a domain verified in Resend, or sends will be
rejected). If `RESEND_API_KEY` isn't set, task creation/editing still works fine — the email side
just no-ops with a clear inline error, same "optional integration degrades gracefully" pattern used
elsewhere (e.g. the webhook auto-wiring in Channels). Each task row also has a "📧 Follow Up" button
that re-sends this same email as a manual nudge.

**"Mine" filter / knowing who's logged in** — the session JWT only ever carries the shared account's
`cid`, not which specific teammate (from `team_emails`) is behind a given browser session. Fixed by
having `POST /session/exchange` also return the verified `email` from the Authentik userinfo call it
already makes (previously discarded) — the frontend stores it as `sessionStorage.lv_me_email` /
the `myEmail` JS var, used to filter manual tasks assigned to whoever is actually logged in right
now, and to visually mark "(you)" in the assignee dropdown.

## Advanced Pipeline follow-up cadence
Whenever a lead's Stage changes, makes sure a rep always has exactly one open, tagged follow-up
task queued for it — "no lead sits without a next action" — escalating Day 1 → Day 3 → Day 7 →
Day 14 → every 30 days after that while a lead stays stuck in the same stage. Built on top of two
already-existing systems rather than a new one: the cadence *tracking* is a new D1 sidecar table
(no NocoDB reader, same reasoning as every other D1 table in this file), and the actual to-do items
a rep sees are ordinary entries in the existing Tasks module's `manual_tasks` (see "Task manager"
above) — this feature never introduces a second task list.

**Why this is separate from the classic `followup_messages` sequence, the Follow-up Engine, the
recovery ladder (`backend/recovery.js`), and Automations flows** — all four of those *send messages
automatically*; this feature only ever *creates a task for a human to act on*, tagged with which
channel/mode to use. A client can have all of these running at once with no conflict: the classic
sequence/recovery ladder/Automations nudge a *silent* lead via WhatsApp on their own schedule
regardless of Stage, while this feature reacts specifically to *Stage changes* and always leaves a
rep-visible task behind, whichever (if any) of the other systems also fired.

### Schema
**Clients table** — one new field: `pipeline_followup_enabled` (Single line, "Yes"/"No") — opt-out,
same convention as `recovery_enabled`: blank or anything but the literal "No" means enabled.
Settings toggle on the Voice page (`cfgPipelineFollowupEnabled`/`renderPipelineFollowupCard`/
`savePipelineFollowupToggle`, `dashboard.html`), right below the two Voice Follow-up toggles it's
otherwise unrelated to — kept there since that's the existing "nudge automation" settings group
rather than inventing a new settings section for one toggle.

**D1** (`migrations/0013_pipeline_followups.sql`) — `pipeline_followups`, one row per lead
(`UNIQUE(lead_id)`): `client_id, lead_id, stage, stage_entered_at, step, cold, channel,
last_task_id, created_at, updated_at`. Tracks progress only — deleted entirely once a lead reaches
a terminal stage (`pipelineClearLead`), at which point its cadence is simply over.

### The cadence rule (`pipelineFollowupTargetStep`/`pipelineFollowupPlan`, `worker.js`)
`PIPELINE_FOLLOWUP_DAY_THRESHOLDS = [1,3,7,14]`, then every 30 days after that. At each threshold,
exactly one new task is created (never more than one per tick, even if a slow tick skipped past
several thresholds at once — it simply catches up over the following days):

| Step | Fires | Channel/mode if the lead has replied since the stage began | If **not** (the "no reply after 2 follow-ups" case) |
|---|---|---|---|
| 1 | Day 1 | 💬 WhatsApp, text | — |
| 2 | Day 3 | 💬 WhatsApp, voice note | — |
| 3 | Day 7 | 💬 WhatsApp, **video** — a short personal clip reads best right after a lead goes quiet | 📞 **Call** the lead directly — flagged **cold** |
| 4 | Day 14 | 💬 WhatsApp, text | 📧 **Email** — flagged cold |
| 5+ | every 30 days | 💬 WhatsApp, text ("Monthly check-in") | 📧 Email ("Monthly check-in — try email") — flagged cold |

`hasReplied` is recomputed fresh every tick from the lead's own `LastMsgAt` vs. the stored
`stage_entered_at` (not a one-way ratchet) — a lead flagged cold after two silent steps that later
genuinely replies clears the flag and the channel/mode plan on the very next tick, same as it was
set. The **cold flag surfaces as an ordinary Tag** (`pipelineMaybeTagCold` appends/removes `"cold"`
on the lead's existing `Tags` field) rather than new UI plumbing — it already renders everywhere
(kanban card, lead list/table, lead detail) via the existing `parseTags`/`tagClass` machinery, so
"tag follow-ups by type" and "flag cold" both reuse the same mechanism the rest of the app already
has for exactly this.

**Two firing paths**, mirroring the same reasoning Automations/recovery.js already established for
a multi-day cadence ("nothing guarantees the tab that built this stays open that long"):
- **Instant**: `dashboard.html`'s `reportLeadQualityChange` — the one function every Stage-changing
  call site already routes through (`kbDrop`, `saveLead`, `patchDetailField`, Human Deals'
  `applyHumanDealOutcome`) — fire-and-forgets `POST /pipeline/followups/on-stage-change` the moment
  `after.Stage!==before.Stage`. Resets the D1 row to step 1 and creates the Day-1 task right away.
- **Daily cron**: `runPipelineFollowupsForAllClients`, piggybacked on the existing `0 2 * * *`
  health-check tick (`wrangler.toml`). Advances every lead already mid-cadence whose next threshold
  has passed, AND catches any Stage change the instant route never saw — a bot-driven Stage move
  from the Conversation Engine has no browser call site to fire that route from, so this tick
  detects `stored stage !== lead's current Stage` itself and resets exactly the same way, just up
  to a day late. Also the path that cleans up a lead's cadence once it reaches a terminal stage
  (`won`/`converted`/`lost`/`human_handover`/the legacy n8n terminal names), and the one-day
  bootstrap for a lead with no cadence row yet (feature just turned on, or the instant call failed)
  — accepted, documented limitations rather than added complexity to backfill exactly.
- Batches to **one `manual_tasks` read-modify-write per client per tick**, even when several of
  that client's leads advance on the same run — same "bulk save, not per-field" convention this
  file already uses for other CLIENTS JSON blobs.

### The one genuinely new send capability: video follow-up
Everything else reuses an existing send path — the text/voice steps go through the exact same
`POST /broadcast/followup-send` the Tasks page's "💬 WA Follow-up" button already used (which
already tries a Sarvam voice note if `voice_followup_enabled` is on, so step 2 needs zero new code,
just correct labeling); the call/email steps are just task labels, since neither can be automated
(a `tel:` link is offered for one-tap dialing; email has no lead-facing send path in this app to
reuse — see "Known scope" below).

The video step needed a real new capability: a rep records/picks a short clip and sends it to that
one lead. `handlePipelineVideoSend` (`POST /pipeline/followups/video-send`) mirrors `handleQuoteSend`
exactly — a FormData relay straight through to Chatwoot (`conv_id` + `file`), so the Chatwoot token
never reaches the browser — deliberately **not** persisted to R2 first, unlike Hospitality/Ecom
category media: those get re-served to many different leads over time, this clip is sent once and
never needs serving again. `dashboard.html`'s new `modalVideoFollowup` (a body-level modal, per the
"Frontend modal convention" above) offers a native file picker (`accept="video/*" capture="user"`,
so it opens the camera directly on mobile) with a preview and an editable caption, wired from a new
"🎥 Record & Send" button that only appears on a task whose `mode==='video'`
(`pipelineFollowupActionsHtml`, `taskItemHtml`).

### Task shape
Auto-generated tasks are ordinary `manual_tasks.items` entries (category `'Follow-up'`, same
palette as every other task) with a few extra fields: `auto_generated:true`, `followup_step`,
`stage_at_creation`, `channel`, `mode`. `assignee_email` is set straight from the lead's own
`Owner` — already the same identity space as `getTeamMembers()` (see "Task manager" above) — so it
shows up in that rep's own "Mine" filter without any extra lookup. `computeAllTasks()` carries
`channel`/`mode`/`auto_generated`/`followup_step` through onto the rendered task object;
`taskTagsHtml`/`pipelineFollowupTagHtml` render a small channel-icon + mode-label chip (e.g. "💬
Video", "📞 Call") on top of the usual category/project tags, so a rep sees which mode to use next
without opening the task.

### Known scope
- **No automated call/email sending** — a phone call obviously can't be automated, and this app
  has no existing lead-facing (as opposed to internal task-notify) email send path to reuse, so
  building one was out of scope here; both steps stay task labels + a `tel:` convenience link.
- **The daily-cron bootstrap for a pre-existing lead** treats "now" as its stage-entry point rather
  than reconstructing the real one, so a lead that already existed when this feature shipped gets
  its first task up to a day later than a freshly-Stage-changed lead would.

## Calendar events (Tasks page → Calendar view)
A rep can put an important date on the calendar — a Lead Follow-up, an Exhibition, a Startup
Mission Program date, a Birthday, or any other Important Date — and assign a Meta-approved
WhatsApp template to it up front, so the outreach actually fires itself on the day instead of
depending on someone remembering to send it. Distinct from the Calendar view's pre-existing manual-
task pills (`renderTasksCalendar`'s original due-date grid, untouched) — events are their own thing,
plotted on the same month grid with a type-colored pill, plus a dedicated "Upcoming Events" list
below the grid (the grid cells are too small to show audience/template at a glance).

### Schema
**CLIENTS** — one new field: `calendar_events` (Long text, JSON array) — same config-blob pattern
as `automation_flows`/`manual_tasks`, not a dedicated table (a client has a handful of standing
events, not thousands of rows). Item shape:
```json
{
  "id": "ce_...", "title": "Dubai Trade Fair", "type": "Exhibition",
  "date": "2026-08-15", "recurring_yearly": false,
  "audience_mode": "segment", "segment": {"stage": ["qualifying"], "tags_any": ["VIP"]},
  "lead_id": null, "lead_name": "", "contact_name": "", "contact_phone": "", "contact_lead_id": null,
  "template_name": "exhibition_invite", "template_category": "MARKETING", "template_language": "en",
  "template_vars": ["", "Dubai World Trade Centre", "Aug 15"], "personalize_first": true,
  "notes": "", "created_at": "2026-..."
}
```
**D1** (`migrations/0014_calendar_events.sql`) — `calendar_event_sends` (`client_id, event_id,
lead_id, occurrence_key, sent_at`, unique on `(event_id, lead_id, occurrence_key)`) — a dedupe log
only, not the events themselves. `occurrence_key` is the actual date fired for (see below), so a
recurring event gets a fresh key — and therefore a fresh send — every year.

### Audience — three shapes, chosen per event (`worker.js`'s `CALENDAR_AUDIENCE_MODES`)
- **`lead`** — a single existing Lead (the natural fit for "Lead Follow-up").
- **`segment`** — every Lead matching a Stage/Tag filter, exactly the same shape and
  `leadsAudienceWhereClause` the Automations module's segment audience already uses (its stage-chip
  picker UI is mirrored here too — `.seg-chip`, ported into `dashboard.html` since this lives on the
  Tasks page, not `broadcast.html`) — for a broadcast-style event like an Exhibition invite.
- **`contact`** — a name + phone not yet in the CRM at all (a personal contact's Birthday). The
  first time this event actually fires, a minimal Lead row is created for them (`Stage:'new'`,
  tagged `"Calendar Contact"`) and its id is written back onto the event (`contact_lead_id`), so
  every later occurrence (next year's Birthday) reuses the same Lead instead of creating a new one.

### Recurrence
`recurring_yearly` (a plain checkbox on every event, not locked to a type — a Birthday defaults
mentally to yearly but nothing stops an Exhibition from repeating too) — `calendarOccurrenceDate`
takes the event's stored month/day and pairs it with whichever year is being checked, so a
recurring event is "due" every year on the same date, and a non-recurring one only ever has its
one literal `date`.

### Template & variables
Templates are the client's existing Meta-approved list, listed/synced through the exact same
routes the Template Broadcast tab already uses (`GET/POST /broadcast/templates(/sync)`) — no new
template-management surface. Unlike a live broadcast send, **variables are resolved once at
event-creation time**, not per-recipient — an Exhibition/Important Date's details are the same for
everyone invited. `personalize_first` is the one per-recipient exception: it substitutes `{{1}}`
with each individual recipient's own `Name` at send time. The modal's var-input/live-preview UI
(`ceVarFields`/`updateCalendarTemplatePreview`) deliberately mirrors `broadcast.html`'s Template
Broadcast tab (`getTemplateVarCount`/`buildVarFields`/`updatePreview`) — same mechanic, just
resolved-once instead of resolved-live.

### Sending (`worker.js`)
- **Daily cron** (`runCalendarEventsForAllClients`, piggybacked on the existing `0 2 * * *` tick
  alongside the health check and Advanced Pipeline cadence — day-granularity, no need for its own
  finer schedule): for every client, finds events due today (recurring or not), resolves the
  audience, and sends the assigned template to each recipient not already recorded in
  `calendar_event_sends` for this occurrence.
- **Manual "Send Now"** (`POST /calendar/events/send-now`, `handleCalendarEventSendNow`) — lets a
  rep test a template immediately, or fire an Exhibition invite on demand instead of waiting for
  its calendar date. Ignores the dedupe table (an explicit click should always go out) but still
  logs the send so the *next* scheduled occurrence that same day doesn't double-send.
- Template send itself reuses the exact Chatwoot call shape `handleBroadcastSendTemplate` already
  uses (`template_params: {name, category, language, processed_params}`), just built server-side
  from the event's stored `template_vars` instead of a live request body.

### Known limitation — same one this file already has elsewhere for any brand-new contact
A template can only be delivered into an **existing** Chatwoot conversation — there is no
proactive "start a new WhatsApp conversation" capability anywhere in this app; conversations are
only ever created by an inbound message hitting the engine webhook (Automations' own
`send_whatsapp_template`/`send_whatsapp_dm` flow steps have this exact same gap — see
`flowLeadConvId`'s no-op-if-missing check). A `contact`-audience event, or a `lead`/`segment`
recipient who has never messaged in, silently skips that recipient (not retried, no error
surfaced beyond the event just not showing a send) until they've sent at least one real WhatsApp
message — every occurrence after that sends fine. Building a genuine cold-outreach path (Chatwoot
Contacts + Conversations API, or Meta's Cloud API directly via `wa_phone_id`/`wa_token`) would be a
real, separate, unverified piece of infra and was deliberately left out of this pass rather than
shipped untested.

## Google Calendar sync (Task Manager)
One-way push: manual Tasks (due dates) and Calendar Events (see "Calendar events" above) get
created/updated/deleted as real events on a dedicated **"Leadvyne Tasks & Events"** Google Calendar
the moment they're created/edited/marked done/deleted in Leadvyne — so a rep sees their Leadvyne
work on their phone's own calendar app without opening the dashboard.

**Reuses the exact same Google Cloud OAuth Client as Google Search Console** (see "Reports page"
above) — `signOauthState`/`verifyOauthState` + browser-redirect-callback shape, `GOOGLE_CLIENT_ID`/
`GOOGLE_CLIENT_SECRET`, just a different scope (`https://www.googleapis.com/auth/calendar` instead
of `webmasters.readonly`) and its own callback URL (`/gcal/oauth/callback`, needs adding as a second
authorized redirect URI on the same Cloud project, alongside enabling the Google Calendar API).

### Schema — CLIENTS table
- `gcal_refresh_token` (Single line, secret — stripped by `safeClient()`, exposed as
  `gcal_connected:!!gcal_refresh_token`, same pattern as `gsc_refresh_token`).
- `gcal_calendar_id` — the id of the dedicated secondary calendar, created once at connect time
  (`gcalCreateCalendar`, `POST .../calendars` with `summary:"Leadvyne Tasks & Events"`) rather than
  reusing the rep's primary calendar — keeps a disconnect/reconnect clean and never clutters
  whatever the rep already has on their main calendar.
- `gcal_connected_at`.
- One new field per synced item: `gcal_event_id` — on a manual task (`manual_tasks.items[]`) and on
  a Calendar Event (`calendar_events[]`), the corresponding Google Calendar event id, so a later
  edit/delete PATCHes/DELETEs the same remote event instead of creating a duplicate.

### Connect UI
A small status strip at the top of Tasks → Calendar view (`renderGcalStatus`, `#gcalSyncStrip`) —
not a dedicated Settings page, since Calendar is the one place a rep is already thinking "my tasks
vs. my calendar". `connectGcal()`/`disconnectGcal()` mirror `connectGsc()`/`disconnectGsc()`
exactly. Disconnecting only clears the CLIENTS fields — it deliberately does **not** delete the
Google-side calendar or its events, so a rep who disconnects (even by accident) doesn't lose
anything already synced there; they can delete the calendar themselves in Google Calendar if they
want it fully gone.

### Push mechanics (`worker.js`)
- **Calendar Events** have full server-side CRUD already (`handleCalendarEventCreate/Update/
  Delete`) — the Google push is just one more step inside each of those three handlers
  (`gcalSyncCalendarEvent`/`gcalDeleteEvent`), always as an **all-day** Google event (these are
  dates, never timed appointments), using Google's own native `recurrence:['RRULE:FREQ=YEARLY']`
  for a `recurring_yearly` event — purely cosmetic on the Google side; Leadvyne's own cadence/
  dedupe logic for *sending the WhatsApp template* (`calendarOccurrenceDate`, the D1 dedupe table)
  is entirely separate and unaffected by however this renders in Google Calendar.
- **Manual Tasks have no server-side CRUD at all** — `dashboard.html` writes the whole
  `manual_tasks` blob directly via the generic `/nocodb/*` passthrough (`saveTasksState()`). So
  unlike Calendar Events, this needed a dedicated route, `POST /gcal/sync-task`
  (`handleGcalSyncTask`), that the frontend calls right after its own save already succeeded —
  passing just that one task's current shape (`syncTaskToGoogleCalendar(taskId, action)`, called
  from `saveTaskFromModal`/`moveTaskStatus`/`snoozeManualTask`/`deleteManualTask`) rather than the
  Worker re-parsing the whole tasks blob itself. A task syncs as a **timed** Google event
  (`dateTime`, fixed 30-minute duration — Google requires an end time and this app never tracks a
  task's actual duration) if it has a `due_time`, or all-day if it only has a `due_date`. Marking a
  task done, clearing its due date, or deleting it all delete the corresponding Google event rather
  than leaving a stale/completed entry behind — a synced calendar should only ever show what's
  still actually outstanding.
- **A previously-synced event the rep deleted directly in Google Calendar** comes back 404/410 on
  the next PATCH attempt — `gcalUpsertEvent` recovers by creating a fresh one instead of leaving
  that task/event permanently un-synced.
- On success, the frontend patches the returned Google event id back onto the task/event with a
  second small `saveTasksState()`/the Calendar Event's own save — a bit of extra chatter for manual
  tasks specifically (two saves instead of one), but simple and safe for what is, in practice, a
  single-editor-at-a-time app.

### Known limitation — genuinely one-way, by design
An edit made **directly in Google Calendar does not flow back into Leadvyne**. True two-way sync
needs either a push-notification channel (Google Calendar's `watch`/webhook API, which expires and
must be renewed on its own schedule) or periodic polling with a sync token — both real, separate
pieces of infra distinct from the one-way push built here, and deliberately left as a documented
next step rather than shipped half-built. In practice this covers the stated need well: seeing
Leadvyne's tasks/events on a rep's own calendar app, which this delivers in full; editing a task's
due date *from* the phone's calendar app and having that reflect back into Leadvyne does not yet
work — edit it in Leadvyne instead, and the next sync push updates Google Calendar to match.

## Per-client customization (Mix 1)
- **Config** — edit that client's row (flow, prompt, follow-ups). No workflow edit.
- **Wrapper** — open that client's generated workflow; add nodes around `Run engine`
  (there's a comment marking where). Isolated to that client.
- **Custom logic** — give the engine a `custom_subworkflow_id` branch for a one-off client.
- Never hardcode a client inside the shared engine — keep it generic and config-driven.

## Tuning
- `engine.json` is a working foundation — test each media branch once; Chatwoot attachment
  field names vary slightly by channel. WhatsApp voice is ogg/opus; swap the transcribe node
  for your STT if needed.
- Confirm the n8n API response shape for the created workflow id (`id` vs `data.id`) — the
  activate node handles both.

## Recovery / win-back engine (backend/recovery.js)
A standalone scheduled service (does not touch `engine.json` or `nba.js`) that nudges silent
leads with an escalating 3-step drip: soft check-in → nurture → last-chance win-back. Runs
hourly, reads the clients table read-only, and only writes to new `recovery_*` fields on the
leads table (auto-created on first run) — it never writes `Stage`, `ConvHistory`, or `LastMsgAt`.

- If a client has the classic `followup_count` sequence configured (followup-template.json),
  this engine waits until that sequence is exhausted before starting its own ladder, so a lead
  is never double-messaged by both systems.
- Skips leads that are terminal (`Converted`/`Lost`/`Closed`/`Opt Out`), opted out, or currently
  `Handover`'d to a human agent.
- Escalation timing and copy are configurable per client (all optional — sane defaults apply if
  left blank) via new columns on the **CLIENTS** table:

  | Field | Type | Meaning |
  |---|---|---|
  | recovery_enabled | Single line ("Yes"/"No") | Set "No" to disable the ladder for this client |
  | recovery_gaps_hours | Single line, e.g. `6,48,168` | Hours-since-previous-step before each of the 3 stages fires |
  | recovery_messages | Long text, 3 lines | One message template per stage; `{name}` is replaced with the lead's name |
  | recovery_templates | Long text, up to 3 lines | Optional: approved WhatsApp template name per stage, for use once the 24h session window has closed (leave blank to send plain text) |
  | recovery_template_lang | Single line | Template language code (defaults to the client's `language`) |

- Deploy as its own container: `docker compose up -d leadvyne-recovery` (see
  `backend/docker-compose.yml`). Test a single run with `RUN_NOW=1`.
- Uses the same `NOCODB_TOKEN`/`CLIENTS_TABLE` as `nba.js`; no new credentials needed unless
  Voice Follow-ups is used (see below), which needs its own `SARVAM_API_KEY`.
- **Voice Follow-ups** (`client.voice_followup_enabled`, Settings → Voice — see "Voice module"
  below): when a client has this on, a plain-text recovery/win-back stage (not a template stage —
  templates never go through this) tries a Sarvam AI voice note first, same pipeline as
  `cloudflare-worker/worker.js`'s live voice-to-voice replies, ported natively into this file
  (`sarvamTts`/`sendVoiceMessage`/`extractLinkPriceCaption`, since this is a separate Node process
  with no access to the Worker's own secrets/helpers) — falls back to the normal
  `sendPlainMessage` text send on any failure (no `SARVAM_API_KEY` set, an unsupported language, or
  the TTS call itself failing), so a follow-up is never skipped over a voice hiccup. Requires
  `SARVAM_API_KEY` as an env var on this container specifically (`backend/.env.example`,
  `backend/docker-compose.yml`'s `leadvyne-recovery` service) — same key as the Worker's own secret,
  just needs setting again here since it's a different deployment. `sendVoiceMessage` targets
  `lead.Language` (the lead's own last-detected language, same field the live bot engine stamps —
  see "Every reply now follows the customer's own detected language" above), falling back to
  `client.language` only if this lead has never had a language detected — not the client's static
  setting, so a win-back voice note replies in whatever language the customer was last actually
  speaking.
- **This ladder runs fully automatically** — `docker compose up -d leadvyne-recovery` schedules it
  hourly via `node-cron` (`RUN_NOW=1` for a single on-demand run); no rep action is needed for a
  silent lead to get nudged, voice included. This is distinct from the classic `followup_messages`
  sequence's Voice Follow-ups (see "Follow-up Engine" above), which is manual only — sent by a rep
  clicking "Send Next Now", not on any schedule.

## Ecom bot memory (`ecom_prefs`) and product filtering
Two additions that fix the ecom WhatsApp bot forgetting a customer's stated size/color mid-order
and re-answering in the wrong language turn to turn (see `n8n/ecom-bot.json`).

**`ecom_prefs`** — new LongText column on the **Leads** table (same pattern as `QualAnswers`,
already used elsewhere for durable per-lead state that shouldn't be re-derived from the raw chat
transcript every turn). One JSON object per lead:

```json
{
  "size": "S",
  "color": "green",
  "category": "shirt",
  "last_sku": "TSHIRT-GRN-S",
  "last_product_name": "Men's Classic Green Shirt",
  "budget_max": null,
  "language": "ml",
  "updated_at": "2026-07-09T20:31:00.000Z"
}
```

- Every field is optional/nullable — only set what the customer has actually stated so far.
- `language` is set once (detected from the first message) and reused for every reply after —
  this is what stops the bot answering in Malayalam then English then Malayalam again to the
  same person.
- `updated_at` backs a staleness rule: if the workflow finds `ecom_prefs` older than **6 hours**,
  it treats it as a new inquiry and doesn't carry the old size/color forward — otherwise someone
  asking about a green shirt today could get treated as still wanting a green shirt in an
  unrelated conversation next week.
- Read at the start of every ecom-intent message, merged with whatever new slots the current
  message adds (a customer naming a color doesn't erase a previously-stated size), then written
  back after the reply is sent.

**`/ecom/products` filter/sort params** (`cloudflare-worker/worker.js`, `handleEcomList`) — lets
the bot ask NocoDB for only the products that already match instead of dumping the whole
catalogue into the AI prompt for it to search (slower, costlier, and the main source of the bot
"inventing" a product that doesn't actually exist):

| Param | Behavior |
|---|---|
| `color` | Partial, case-insensitive match (shop-owner free text like "Bottle Green") |
| `category` | Partial, case-insensitive match |
| `size` | Exact match (S/M/L/XL etc. are short coded values, not prose) |
| `min_price` / `max_price` | Inclusive price range |
| `in_stock=true` | Only `stock > 0` |
| `include_inactive=true` | Skip the default `status != inactive` filter |
| `sort` | One of `price_asc`, `price_desc`, `newest`, `oldest`, `stock_desc`, `name_asc` — a whitelist, not a raw passthrough, since this endpoint has no session of its own |

Example: `GET /ecom/products?client_id=123&color=green&size=S&in_stock=true&sort=price_asc`

## Public storefront (`frontend/store.html`) and per-product order links
A read-only, no-login page customers can open straight from a WhatsApp link — lets the ecom bot
hand over a real "Order on WhatsApp" button instead of asking the customer to type out every
detail in chat.

- **`frontend/store.html?client=<id>`** — lists that client's active products (name, price,
  size, color, photo, stock badge) with a search box and a per-product "Order on WhatsApp" /
  "Ask about restock" button that deep-links to `https://wa.me/<support_phone>` with a
  pre-filled message. `&sku=<sku>` scrolls/highlights straight to one product. No admin
  controls of any kind live on this page — it only ever calls the two read-only endpoints below.
- **`GET /ecom/public/client?client_id=`** and **`GET /ecom/public/products?client_id=`**
  (`cloudflare-worker/worker.js`) — deliberately separate from the `/ecom/client` and
  `/ecom/products` admin endpoints ecom.html uses. Three things keep this from exposing more than
  a product catalog: (1) GET only, no create/update/delete handler exists under `/ecom/public/*`
  at all; (2) a fixed field whitelist on both the client record (`client_name`, `support_phone`,
  `review_link` only — no table IDs, sheet URLs, or column maps) and each product row (no cost
  price or internal notes, even if those columns exist); (3) it never touches leads/orders.
  Still scoped by `client_id` the same way every `/ecom/*` route is — see the comment above
  `ECOM_CLIENT_READ_FIELDS` for why that's an accepted trade-off for this whole module.
- **In `ecom-context.json`** (n8n-saas repo) — `Code · Build Ecom Context Block` appends
  `https://app.leadvyne.com/store.html?client=<client_id>&sku=<sku>` to every matched product,
  and the prompt tells the AI to reuse that link verbatim rather than inventing or shortening it.

## Ecommerce categories (`frontend/ecom.html` — 🏷️ Categories tab)
`category` on a product row (`PRODUCT_FIELDS` in ecom.html) has always been a plain free-text
field — no dedicated entity, no images. This adds a proper Categories entity so a category can
carry its own photos, auto-sent to a customer's chat the first time their message names that
category — **entirely separate from, and never overriding, the existing per-product image send**
(`engineDeliverReply`'s `imageUrl:product.image_url`, fired from the `detectOrderSignal`/
`ecomResolveProduct` block in `handleEngineWebhook` — untouched by this feature).

### Schema — Cloudflare D1 (`env.DB`, `migrations/0012_ecom_categories.sql`)
D1-backed, not NocoDB — a genuinely new data shape with no existing NocoDB reader, same reasoning
as the Hospitality module's units/bookings.
- **`ecom_categories`**: `id, client_id, name, image_url_1/2/3, created_at`. Up to 3 photos per
  category (no video slot — unlike Hospitality's units, a category is a grouping concept, not a
  bookable thing worth a walkthrough video).
- **`ecom_category_media_sent`**: `client_id, lead_id, category_id, sent_at`, unique on
  `(lead_id, category_id)` — same "once per (lead, category) ever" dedup as
  `hospitality_media_sent`.

### Photos — pasted Google Drive links (same switch as Hospitality's unit photos/video)
`image_url_1/2/3` hold a pasted Google Drive share link, not an uploaded file — clicking an empty
slot (`setCategoryMediaLink()`) prompts for a Drive share link and saves it via a plain string
`PATCH /ecom/categories` field (`handleEcomCategoryUpdate`), the same autosave-on-blur pattern
`name` already uses. The category must be shared **"Anyone with the link can view"** — this Worker
fetches it anonymously, no Drive account behind it. A filled slot shows a thumbnail
(`driveThumbnailUrl()` — Drive's public `/thumbnail?id=` endpoint serves real image bytes, unlike
the "view" share link itself, which is an HTML page and won't render in a plain `<img>`); clicking
it opens the Drive link, and the ✕ removes it.
- **Legacy R2 uploads still work, not migrated.** Categories that already had a file uploaded
  before this switch keep their `https://<worker>/ecom/category-media/<key>` URL and keep serving/
  sending fine — `handleEcomCategoryMediaUpload`/`Delete`/`handleEcomCategoryMediaServe` and the R2
  binding (`ECOM_CATEGORY_MEDIA`, one-time setup `wrangler r2 bucket create
  leadvyne-ecom-category-media`) are all still in place, just no longer reachable from the frontend.
  `engineMaybeSendEcomCategoryMedia()` below checks for that URL shape first and only treats
  anything else as a Drive link, so both kinds of categories send correctly side by side.
- `driveFileId()`/`driveThumbnailUrl()` are duplicated in `ecom.html` (matching `dashboard.html`'s
  own copies — no shared build step across pages) to extract the file id from whichever share-link
  shape was pasted and build the thumbnail preview URL.

### Worker routes (`cloudflare-worker/worker.js`)
`GET/POST/PATCH/DELETE /ecom/categories`, `POST/DELETE /ecom/categories/media` (legacy upload/
delete, see above), `GET /ecom/category-media/*` (public serve, no auth — same trust model as
`handleHospitalityMediaServe`: Chatwoot/WhatsApp's own media fetch and a plain `<img>` tag can't
send an Authorization header, and the key itself isn't guessable). **Not `requireSession`-gated**
— same client_id-based auth as every other `/ecom/*` route (`ecom.html` has no session token to
send; see `ECOM_CLIENT_READ_FIELDS`'s own comment for why this is an accepted trade-off for this
whole module), not a second, inconsistent trust model just for this feature.

### Auto-send — `engineMaybeSendEcomCategoryMedia()`
Called from `handleEngineWebhook` right alongside `engineMaybeSendHospitalityMedia`, after the
lead upsert. Simple case-insensitive substring match of each category's `name` against the
message text — not an LLM call, same "cheap and predictable, documented over/under-match
tradeoff" as the Hospitality module's unit-name matching (see its own SETUP.md entry).
**Deliberately gated on `orderHandledInline` being false** — if this turn already resolved a
specific product and sent its photo (the existing per-product flow), the category auto-send is
skipped entirely, so a customer asking about one exact item never gets a redundant category photo
dump appended to the same reply. Only fires for `industry==='ecommerce'`.
- **Real bug fix**: this function only ever knew how to fetch bytes from this Worker's own
  R2-hosted `/ecom/category-media/<key>` URLs — any other URL (including a Google Drive link,
  which there was previously no way to even store) silently matched nothing and sent zero photos
  for that slot. It now fetches Google Drive files directly, via the same `driveFileId`/
  `driveFetchFile` helpers `hospitalitySendUnitMedia` uses (confirm-token retry for Drive's
  virus-scan interstitial included), while still supporting legacy R2-uploaded media for any
  category that already had a file uploaded before this change. Every non-empty slot on a category
  is sent independently — an unreachable link on one slot doesn't block the category's other
  photos.

### Frontend (`frontend/ecom.html`)
- **🏷️ Categories tab** — directly-editable table, same convention as `dashboard.html`'s
  Hospitality Units page (no Add/Edit popup): click a name to edit it (autosaves on blur), click
  an empty photo slot to paste a Google Drive link, click ✕ on a filled slot to remove it. "+ Add
  Category" creates one immediately (prompts for a name).
- **Product modal's Category field** changed from a free-text `<input>` to a `<select>`
  (`pmCategory`) populated from the managed categories list, plus a "+ Add new category…" option
  that creates one inline without leaving the modal. **Existing products keep whatever string
  they already had** even if it doesn't match any managed category — `ensureCategoryOptionExists()`
  adds a one-off `"<value> (not in Categories list)"` option before the field's value is set, so
  opening an old product for edit never silently blanks out (and then overwrites on save) a
  legacy category value that predates this feature.

## Product styles (`frontend/ecom.html` — product modal's Style field)
Every product optionally carries a `style` — **Fashion & Garments** (the default, and the only
style that existed before this feature — its fields and behavior are completely unchanged),
**General**, **Cosmetics**, or **Haircare**. Style is picked **per product**, not per client/store,
so one catalog can mix styles (e.g. a store selling both clothing and cosmetics). A blank or
unrecognized `style` on a product is always treated as `fashion_garments` — no existing product
needs to be touched for anything to keep working exactly as before.

### Schema — NocoDB product table columns, auto-provisioned
Products live in the client's own NocoDB products table (`ecomResolveTable(..., 'products')`),
not this repo's D1 DB — same as every other product field. New columns: `style`, `shade`,
`skin_type`, `volume_ml`, `expiry_date`, `hair_type`, `concern`, `ingredient`, `brand`, `variant`,
`warranty_period`, `shopify_product_url`. `volume_ml`/`ingredient` are shared between Cosmetics and
Haircare rather than duplicated per style, to keep the schema smaller.

`ensureEcomProductStyleFields()` (`cloudflare-worker/worker.js`) auto-creates any missing column
the first time a client's products table is written to (`handleEcomCreate`/`handleEcomUpdate`) —
same GET-fields-then-POST-if-missing pattern as `ensureFlowStateField`/`ensureB2bLeadFields`,
memoized per table id (not a single shared boolean, since every client can have a different
products table). No manual NocoDB setup step is required to start using a new style.

### Fields per style
- **Fashion & Garments** (default): `color`, `size` — unchanged from before this feature.
- **General**: `brand`, `variant` (e.g. "500ml", "Pack of 2"), `warranty_period`.
- **Cosmetics**: `shade`, `skin_type`, `volume_ml`, `expiry_date`, `ingredient`.
- **Haircare**: `hair_type`, `concern` (e.g. dandruff, hairfall), `volume_ml`, `ingredient`.

### Frontend (`frontend/ecom.html`)
- Product modal has a **Style** `<select>` (`pmStyle`); the fields for the other three styles sit
  in the same `.modal-grid` as `<div data-style-group="...">` blocks, shown/hidden by
  `onProductStyleChange()` based on the selected style — no separate popup or page.
- Products table has a **Style** column (`PRODUCT_STYLE_LABELS`).
- CSV import/export (`PRODUCT_FIELDS`, `downloadProductTemplate()`, `parseImportCsv()`) covers all
  style fields — the template download includes one sample row per style.

### Chat / AI behavior (`cloudflare-worker/worker.js`)
`ecomStyleAttributeLines(product)` builds the style-specific detail lines (e.g. "Shade: Rose Nude",
"Hair type: Curly") from a product's `style`, shared by:
- `engineBuildProductEnquirySystemPrompt` — the single-product WhatsApp reply prompt, right after
  the existing color/size/category lines (which stay exactly as before).
- `engineBuildEcomContext` — the whole-catalog KB block injected into the general chat prompt.

### Reports — `style_breakdown` (`handleShopifyAnalytics`, reused by `/reports/products`)
`top_products` (title/quantity/revenue) is **unchanged** — this is still the only breakdown for
Fashion & Garments products, by design. A new, purely additive `style_breakdown` object in the same
response adds, only for styles that have data: `cosmetics.by_shade`/`by_skin_type`,
`haircare.by_hair_type`/`by_concern`, `general.by_brand`/`by_variant` (same `{key, quantity,
revenue}` shape as `top_products`, top 10 each). Built by joining each order line item back to its
product (by `sku`, falling back to a lowercased name match for the non-Shopify `items`-text order
path, which has no sku) — line items themselves never carry style/attribute data.
`frontend/dashboard.html`'s `ecomStyleBreakdownCards()` renders one extra card per style present,
after the existing (untouched) Top Products card, in both the Shopify Analytics and Product
Performance report tabs.

## Per-product audio note / video / PDF (`frontend/ecom.html` product modal, `cloudflare-worker/worker.js`)
Three new optional fields on a product — `audio_url`/`video_url`/`pdf_url`, pasted Google Drive
share links, same convention as every other media field in this app (Hospitality units, Ecommerce
categories' photos above). Sent right after the product's existing photo whenever that specific
product is confidently identified in the conversation — a customer asking about/selecting a
product can now get a voice note, short demo video, and/or a PDF (spec sheet, brochure) alongside
the photo and text reply, not just a static image.

### Schema — NocoDB product table columns, auto-provisioned
`audio_url`/`video_url`/`pdf_url` are added to the same `ECOM_STYLE_FIELD_TITLES` list
`ensureEcomProductStyleFields()` already auto-creates missing columns from (see "Product styles"
above) — no manual NocoDB setup step. NocoDB is still the only *source of truth* a product is read
from (no dedicated D1 table modeling the product itself, unlike Ecommerce categories' photos); every
write is additionally mirrored into D1 as a backup copy — see "Ecom product write self-heal + D1
mirror backup" below.

### Sending — `engineMaybeSendProductMedia()` (`cloudflare-worker/worker.js`)
Called from `handleEngineWebhook`'s existing `detectOrderSignal`/`ecomResolveProduct` block, right
after `engineDeliverReply(...,{imageUrl:product.image_url})` — the exact two branches where a
*specific* product was confidently matched (`mode==='order'` and `mode==='enquiry'`), not the
category-browsing fallback branch (no single product is confidently identified there, so there's
nothing specific to attach media to). Unlike the existing photo send (`engineSendChatwootImageReply`,
an image-only thumbnail-URL trick), this reuses the general-purpose `sendDriveMediaToChatwoot`
helper (`worker.js` — the same one Automations & Flow's `send_whatsapp_media` step and the
Follow-up Engine's per-variant media use) since audio/video/PDF need the real file bytes fetched via
`driveFileId`/`driveFetchFile`, not a thumbnail. Best-effort and independent per field — a
missing/unshared link on any one just skips that one send, never blocks the reply or the other two
fields. No per-lead dedup (same as the existing photo send it sits beside) — a customer can ask
about the same product more than once and hear/see/read it again each time, by design.

### Frontend (`frontend/ecom.html`)
Product Add/Edit modal gained **Audio Note Link**, **Video Link**, and **PDF Link** inputs next to
the existing **Image Link** field, all four sharing one hint: paste a Google Drive share link,
shared as "Anyone with the link can view." Also added to `PRODUCT_FIELDS` (CSV template download/
import), so bulk-managed catalogs can set these columns the same way as every other product
attribute — **whenever `PRODUCT_FIELDS` gains or loses a column, the hardcoded `samples` rows in
`downloadProductTemplate()` must be updated to the same column count**, or the downloaded CSV
template ships with sample data shifted into the wrong headers (this happened once already,
silently, when a concurrent PR added `product_link` without updating the samples — fixed alongside
adding `pdf_url` here).

**Frontend is a separate deploy from the Worker.** `wrangler deploy` only ships
`cloudflare-worker/worker.js` — `frontend/*.html` (including this feature's new modal fields) is a
static site deployed independently (SETUP.md "4. Deploy the front-end"). After merging a frontend
change, the static site itself needs redeploying (Coolify redeploy/restart, or wherever it's
actually hosted) before the change is visible — a `wrangler deploy` alone will not surface it.

## Ecom product write self-heal + D1 mirror backup (`cloudflare-worker/worker.js`, `migrations/0043_ecom_products_mirror.sql`)
NocoDB can return `200 OK` on a product create/update while silently discarding a field it doesn't
like the value for — most commonly a `style`/`audio_url`/`video_url`/`pdf_url`/`product_link` column
that got hand-created in NocoDB (or hand-edited afterward) as something other than plain text, e.g. a
Single Select whose fixed option list doesn't include the value being saved. The write looks
successful end to end; the product just silently reverts the moment you reopen it, with nothing to
catch it short of noticing by eye. `ecomVerifyProductWrite()` (called from both `handleEcomCreate`
and `handleEcomUpdate` whenever `kind==='products'`) re-reads the record right after every write and
diffs it against what was sent:

- **Self-heal.** If a dropped field is one of `ECOM_STYLE_FIELD_TITLES` — which only ever hold
  free-form text/URLs, never a legitimate reason to reject a text value — `ecomRepairFieldType()`
  converts that column back to `SingleLineText` via NocoDB's field-meta API and the write is retried
  once. Scoped to just those titles; unrelated columns like `color`/`category`/`status`/`stock` are
  never touched, since those may legitimately be constrained types by the client's own design.
- **Ops alert.** Only if a field is still missing after the repair+retry (or isn't one of the
  self-healable titles) does this fall back to `reportOpsError`, naming the exact table/field/record.
- **D1 mirror.** Whatever NocoDB ends up actually holding — after any repair — gets upserted into
  `ecom_products_mirror` (`ECOM_MIRROR_COLUMNS` in worker.js) keyed by `(client_id, nocodb_id)`, via
  `ecomMirrorProductToD1()`. This is a backup only, not a second read path — `ecom.html`/the chat
  engine still read products from NocoDB exclusively via `ecomResolveTable`. If a client's NocoDB
  base is ever misconfigured, wiped, or unreachable, every product's last-known-good data is still
  recoverable from this D1 table instead of gone with nothing to restore from. Fails silently (logged,
  not alerted) on a D1 hiccup — a backup write must never block or fail the actual product save.
  **Manual step after deploying this**: run `wrangler d1 migrations apply leadvyne-d1 --remote` to
  create the table, same as every other D1 migration in this repo.

## Per-product Shopify link → chat order links (`buildOrderLink`, `cloudflare-worker/worker.js`)
A product can optionally carry its own `shopify_product_url` (set in the product modal, field only
shown once `clientRecord.shopify_shop_domain` shows Shopify is connected — see
`renderShopifyConnection()`). `buildOrderLink(c, clientId, sku, product)` now checks it first,
ahead of the client-level `external_store_link` and the built-in storefront fallback — the most
specific link available wins. `sendOrderLinkNow`/`sendOrderLinkViaChatwoot` resolve the matched
product before building the link so it's available to pass in.

## onshope.com — dedicated storefront domain, client slugs, and the real WhatsApp number
`store.html` above lives under `app.leadvyne.com`, which reads as "the SaaS backend" to a
customer and produces long, tracking-parameter-looking links (`?client=1&sku=...`). onshope.com
is a second, brand-neutral domain for the customer-facing side only — same backend, separate
frontend files, short URLs.

- **`frontend/onshope-home.html`** — directory homepage (IndiaMART-style): lists every client
  that has published a store, links to `/<slug>`.
- **`frontend/onshope-store.html`** — per-client storefront, identical generic design for every
  client, resolved by `?slug=` instead of `?client=`. Deliberately a separate file from
  `store.html` — different brand/palette, not part of the Leadvyne dashboard's own frontend.
- **`client_slug`** — new short-text column on the **Clients** table, e.g. `vintage1950`. Must
  be unique and URL-safe (letters/digits/hyphen/underscore). Set directly in NocoDB for now (same
  as `ecom_prefs` before it) — no dashboard UI for editing it yet. A client only appears on the
  onshope.com homepage once both `client_slug` is set **and** `industry` is `ecommerce`.
- **`frontend/nginx.conf`** — new `server_name onshope.com www.onshope.com` block: `/` serves
  `onshope-home.html`; any bare `/<slug>` path rewrites to `onshope-store.html?slug=<slug>`.
- **`GET /ecom/public/client` / `GET /ecom/public/products`** now accept **either** `client_id`
  (store.html) **or** `slug` (onshope.com) — same handlers, same whitelist, just an extra lookup
  path (`getClientBySlug`, `cloudflare-worker/worker.js`).
- **`GET /ecom/public/stores`** — new, powers the onshope.com homepage directory. Returns only
  `{client_slug, client_name}` for clients with both a slug and `industry=ecommerce` set.
- **The real WhatsApp number fix**: `wa_phone_id` (saved when a client connects WhatsApp in
  Settings → Channels) is Meta's internal phone-number-id, not something a customer can dial.
  `handleChannelsWhatsappConnect` already fetched the real `display_phone_number` from Meta but
  never saved it — it's now persisted as **`wa_display_phone`**, and every public endpoint's
  `whatsapp_phone` output field prefers it over the older, manually-typed `support_phone`. This
  is what makes "order from the storefront" and "chat with the bot" the same WhatsApp thread.
- **`support_phone` had no UI to actually set it** until ecom.html's "Storefront Order Button"
  settings card was added — despite being documented and read here since this section was written,
  any client without `wa_display_phone` (i.e. anyone whose WhatsApp inbox wasn't created through
  `handleChannelsWhatsappConnect` — a client set up before self-service Channels existed, or wired
  up by hand in Chatwoot) had no way to give the storefront a number at all, so `store.html`
  rendered a disabled "Contact store to order" label instead of an order button for every one of
  their products. `handleEcomClientUpdate`'s write whitelist (`ECOM_CLIENT_WRITE_FIELDS`) and read
  whitelist (`ECOM_CLIENT_READ_FIELDS`) now both include `support_phone`.

**Manual steps still needed outside this repo** (not achievable from a code change alone):
1. Buy/point `onshope.com` (and `www.onshope.com`) DNS at the same host serving `app.leadvyne.com`.
2. Add `https://onshope.com` (and the `www` variant) to the Worker's `ALLOWED_ORIGINS` environment
   variable/secret.
3. Set `client_slug` in NocoDB for each client that should appear on onshope.com.

## `engine-ecom-native.json` (n8n-saas repo) — dedicated, native-node ecom engine
`wrapper.json` routes ecommerce clients to a workflow named **"Leadvyne · Engine · Ecom"**
(`engine-ecom.json`) — a generic lead-qualification-funnel engine (intent classes like
BOOKING/AFFIRMATIVE/DELAY, funnel stages, qualification questions) with ecom bolted on as one
FAQ sub-route. That mismatch was the root cause of several "false negative" bugs earlier in this
file. `engine-ecom-native.json` is a from-scratch replacement built specifically for ecom —
**not yet wired into `wrapper.json`**; switch to it by pointing the wrapper's "Execute · Ecom
Engine" node's `workflowId` at "Leadvyne · Engine · Ecom (Native)" once tested.

What's different from `engine-ecom.json`:
- **No generic funnel at all.** No intent classifier, no BOOKING/DELAY/qualification stages —
  every message goes straight to the ecom pipeline. One AI call decides the reply (down from
  three: the old intent-classifier call, the FAQ-reply call, and `ecom-context.json`'s own
  slot-extraction call — now just the slot-extraction call plus this one).
- **Voice messages are actually transcribed.** `engine-ecom.json` never called Sarvam STT for
  ecom — a voice note just became the literal string `"(sent a voice note)"`. The native engine
  downloads the audio, transcribes via Sarvam STT (language dynamic from the client's own
  `language` field, not hardcoded to Malayalam), and if transcription fails, replies with an
  honest "couldn't hear that, please try again" message in the client's language **without**
  spending an AI/catalog round trip on empty input.
- **Dynamic language, not a hardcoded lock.** Replaces the old `main_prompt` suffix's "Respond
  ONLY in {lang}. Never switch languages." with "Respond in the same language the customer is
  currently writing in — switch naturally if they switch."
- **Memory keyed by phone, not just an internal id.** The lead lookup queries NocoDB by
  `(Phone,eq,<phone>)` directly (native NocoDB node, not a raw HTTP call) — a lead, and
  everything hung off it (`ecom_prefs`, conversation history), resolves for a given phone
  number regardless of which client's inbox a message arrives through, same duplicate-detection
  behavior as before but now on a native node.
- **All native nodes except two.** NocoDB (client lookup, lead lookup) and the AI Agent + Chat
  Model (shared OpenRouter credential, same convention as `ecom-context.json`) are native.
  Two things intentionally stay `HTTP Request`, both with a credential (not an inline token):
  Chatwoot has no native n8n node at all, and the lead-record PATCH needs a JS-built body with
  only the fields this turn actually changed — NocoDB's native node sends a fixed field list,
  which would silently blank out fields (like `Handover`) this turn didn't intend to touch.
  Color/size matching, progressive relaxation, Drive photo auto-send, and the storefront order
  link all come from calling the existing `ecom-context.json` sub-workflow unchanged.
- Human handover is now a field the single AI reply call itself returns (`wants_human`), plus
  the same loop-detection safety net as before (3 identical bot replies in a row forces it).

Tested with 53 cases (38 unit tests over the extracted node logic, 15 end-to-end vm simulations
chaining the actual generated `jsCode` through three full conversation turns — text with a
catalog match, a failed voice transcription, and an explicit human-handover request).

## Email Marketing module (Phase 1 — Resend only; SMTP and inbound intake are separate later phases)
A new module, built as plain Cloudflare Worker code (not n8n) per the decision to move new bot/
automation logic into `cloudflare-worker/worker.js` directly — testable, deployed by `git push`,
one source of truth. This phase ships the full campaign tool (new page, audience segmentation,
send flow, server-side unsubscribe enforcement) wired to the existing per-client Resend
integration only. Two follow-up phases are intentionally **not** part of this work: wiring in
client-connectable SMTP sending, and inbound email-based lead intake via Cloudflare Email
Routing — see "Deferred phases" below for what's already been scoped for those.

### Schema — set these up directly in NocoDB (same convention as `client_slug`/`ecom_prefs` before it)

**Leads table** (`mvg6rcw0ia5qqrx`) — two new fields, matching the existing `OptOut`/`ClientId` naming convention:
- `Email` (Single line text) — canonical email address. **There was no first-class email field on
  Leads before this** — the dashboard's lead table only ever read one out of a `QualAnswers` JSON
  blob as a read-only fallback, never wrote one. Back-fill existing leads by scanning `QualAnswers`
  for an email-shaped value where `Email` is still empty, and the Add/Edit Lead modal now has a
  real `Email` input (see "dashboard.html changes" below) so new leads capture it going forward.
- `EmailOptOut` (Single line text, `Yes`/`No`) — independent of the WhatsApp `OptOut` field; a lead
  can unsubscribe from one channel without affecting the other.

**Clients table** (`mxl33bg4wi70fqj`) — one new field for now:
- `email_table_ids` (Long text, JSON) — optional per-client override, e.g.
  `{"campaigns":"<table id>","sends":"<table id>"}`, same escape-hatch pattern as the ecom
  module's `ecom_table_ids`. Not needed for a client using the shared tables below.

**Shared `EmailCampaigns`/`EmailSends` tables** — created in NocoDB, IDs set in `worker.js`:
```js
const EMAIL_CAMPAIGNS_TABLE = 'md3ghcfigac4yqs';
const EMAIL_SENDS_TABLE = 'mr5fvzaq97s6etq';
```
Every client uses these same two tables (rows scoped by `client_id`) unless a client sets its
own override in `email_table_ids` above.

**`EmailCampaigns` table** — one row per campaign:
| Field | Type | Notes |
|---|---|---|
| `client_id` | Number | scoping column |
| `subject` | Single line | |
| `html_body` | Long text | simple HTML |
| `segment_filter` | Long text (JSON) | e.g. `{"stage":["Hot Lead"]}` — JSON blob, not columns-per-filter-type, so new filter criteria don't need a schema change later |
| `status` | Single line | `draft` \| `sending` \| `sent` \| `failed` |
| `created_at` / `sent_at` | Single line (ISO) | |
| `total_recipients` / `total_sent` / `total_failed` | Number | denormalized counters, updated as sends complete |

**`EmailSends` table** — one row per recipient per campaign (why a real table instead of
`broadcast.html`'s capped-50-JSON-blob-on-the-client-row pattern: a campaign needs
per-recipient status/error visibility a 50-entry aggregate log structurally can't provide):
| Field | Type | Notes |
|---|---|---|
| `client_id` | Number | |
| `campaign_id` | Number | |
| `lead_id` | Number | |
| `recipient_email` | Single line | snapshot at send time |
| `status` | Single line | `queued` \| `sent` \| `failed` |
| `error` | Long text | last error, if failed |
| `sent_at` | Single line (ISO) | |

No `unsubscribe_token` column — the unsubscribe link's token is a stateless HMAC over `lead_id`
(reusing `SESSION_SIGNING_KEY` with a domain-separation prefix, same `crypto.subtle` HMAC pattern
already used by `signSession`), so nothing needs to be stored per-send.

### Backend (`cloudflare-worker/worker.js`)
- `safeClient()` (used by `/session/exchange` and `/session/me`, whose result sits in a
  page-lifetime `clientRecord` JS variable in `dashboard.html`/`broadcast.html` for as long as the
  tab is open) now also strips `resend_api_key`, not just `dashboard_password` — a pre-existing
  gap where a live, send-capable API key was shipped to the browser on every login even though no
  *route* ever echoed it back directly.
- New routes, all session-gated via the same `requireSession`/`payload.cid` pattern as
  `/email/client`/`/broadcast/*` (deriving the client from the session, never a client-supplied
  id — the stronger of the two auth patterns already in this codebase, not the weaker
  client-supplied-`client_id` pattern the ecom module uses):
  - `GET/POST/PATCH/DELETE /email/campaigns` — CRUD, ownership-checked like `handleEcomUpdate`.
  - `GET /email/audience/preview` — resolves a campaign's `segment_filter` server-side against
    Leads (`Email` present, `EmailOptOut != 'Yes'`, plus the filter's own criteria) and returns a
    count + small sample, powering the builder's live "this will reach N leads".
  - `POST /email/campaigns/send-init` — resolves the full audience, bulk-creates `EmailSends` rows
    (`status:'queued'`, chunked at 40 per NocoDB bulk-insert like `handleEcomDelete`'s existing
    `CHUNK=40` pattern), sets the campaign to `status:'sending'`.
  - `POST /email/campaigns/send-one` — sends a single queued row via the client's Resend account
    (extracted into a shared `sendClientResendEmail()` helper from the existing `handleEmailTest`
    logic), re-checks `EmailOptOut` immediately before sending (defensive — a long campaign send
    could overlap with someone unsubscribing mid-send), updates the row's status + the campaign's
    counters. Called once per recipient **from the browser**, not looped server-side — same
    pattern `broadcast.html` already uses for WhatsApp sends (`send-dm`/`send-template`), avoiding
    Workers' per-request subrequest/wall-clock limits on a "send to many" feature, and leaving a
    durable per-recipient record if the tab closes mid-campaign.
  - `GET /email/unsubscribe` — the one **unauthenticated** route in this set (no session — it's
    clicked from an email, not the dashboard). Verifies the HMAC token, sets `EmailOptOut:'Yes'`,
    returns a small confirmation page.

### Frontend
- **`frontend/email-marketing.html`** — new dedicated page, structured like `broadcast.html`
  (own self-contained CSS palette, not shared with `dashboard.html`): Compose/Campaigns tab,
  Audience tab (segment builder + live preview count), History tab (per-campaign send stats and
  per-recipient drill-down — the concrete improvement over `broadcast.html`'s capped-log Tracking
  tab), and a Settings tab that links out to `dashboard.html`'s existing Integrations tab for
  Resend/SMTP credentials rather than duplicating those forms here. Same `sessionStorage`
  (`lv_session`/`lv_cid`) auth as `broadcast.html` — only ever opened via `window.open()` from an
  already-logged-in `dashboard.html` tab.
- **`dashboard.html`** — `Email` field added to the Add/Edit Lead modal and the leads table
  (previously read-only via a `QualAnswers` fallback, not editable anywhere); a new nav button
  opens `email-marketing.html`, alongside the existing WhatsApp Campaigns button.

### Deferred phases (scoped, not built yet)
- **SMTP sending** — a client-connectable alternative to Resend (host/port/user/pass). Spiked via
  desk research (Cloudflare's TCP Sockets API docs + a relevant `workerd` GitHub issue), not a
  live deployment test: **port 25 is blocked outright** (anti-abuse); **port 587 with STARTTLS has
  a confirmed, unresolved `workerd` runtime bug** ([cloudflare/workerd#2712](https://github.com/cloudflare/workerd/issues/2712) —
  `startTls()` leaves the stream in a broken locked state); **port 465 with implicit TLS
  (`secureTransport:'on'`) works reliably**. So Phase 2 should support **465/implicit TLS only**,
  which also simplifies the client considerably (no STARTTLS negotiation code needed at all) —
  hand-rolling the EHLO/AUTH/MAIL FROM/RCPT TO/DATA exchange over `cloudflare:sockets`' `connect()`
  stays viable within the existing single-file-Worker constraint (no bundler/build step needed).
  Confirm against a real deployed Worker + a real account (e.g. a Gmail app password) before
  trusting this in production — this finding is grounded in documentation and a bug report, not a
  live test from this environment.
- **Inbound email lead intake** — a new `export default { async email(message, env, ctx) {...} }`
  handler (Cloudflare Email Routing's native trigger), matched to a client via plus-addressing on
  a **dedicated subdomain** (e.g. `leads+<slug>@inbound.leadvyne.com`, using a new
  `email_intake_slug` Clients field — deliberately not `client_slug`, which is onshope.com/
  ecommerce-only and unset for most clients), deduped by an `Email`+`client_id` lookup on Leads
  analogous to phone-based WhatsApp dedup. Needs a dedicated subdomain (to avoid entangling with
  any existing MX records on the root domain) and a Cloudflare Email Routing catch-all rule
  pointing at this Worker — both manual, account/DNS-level steps outside this repo, same shape as
  the `onshope.com` domain wiring earlier in this file. MVP body-parsing should stay deliberately
  narrow (best-effort `text/plain` extraction, not a full RFC 2045 MIME parser) and that limitation
  should be documented, not silently papered over.

## Automations & Flow module (`frontend/broadcast.html` — "⚡ Automations" tab)
A standalone module built *inside* the Campaigns/Broadcast page, deliberately reusing the two
sibling modules' own facilities instead of re-implementing sends: a flow's WhatsApp steps use the
exact same Chatwoot call shape as this page's Direct Message/Template Broadcast tabs
(`handleBroadcastSendDm`/`handleBroadcastSendTemplate` in `cloudflare-worker/worker.js`), its email
step reuses the Email Marketing module's `sendClientResendEmail` helper and unsubscribe-link
footer, and its audience matching reuses the Email module's `segment_filter` shape
(`{"stage":[...], "tags_any":[...]}`, generalized into `leadsAudienceWhereClause`).

### What it is
A **flow** is a small ordered list of steps a lead walks through once enrolled:
- **Triggers**: `manual` (pick a segment, enroll it once via a button), `new_lead` (auto-enrolls
  new leads matching the segment), `stage_enter` (auto-enrolls leads as they enter one of the
  chosen Stages), `no_reply` (auto-enrolls leads silent for N hours — same signal
  `backend/recovery.js`'s ladder already uses, just driving this flow's own steps instead of a
  hardcoded ladder).
- **Steps**: `wait` (hours), `send_whatsapp_dm`, `send_whatsapp_template`, `send_email`,
  `update_field` (writes any Leads column, e.g. `Stage`). Reordered by dragging step cards
  (native HTML5 drag/drop, no library) in the editor.
- Every enrollment path — manual, auto, and the advance tick — refuses to touch a lead that's
  opted out (`OptOut`/`EmailOptOut`), mid human-handover (`Handover`), or in a terminal Stage
  (`Converted`/`Lost`/`Closed`/`Opt Out`), matching `recovery.js`'s existing safety gate.

### Schema
**Clients table** (`mxl33bg4wi70fqj`) — one new field:
- `automation_flows` (Long text, JSON) — an array of flow objects, same config-blob-on-CLIENTS
  pattern as `followup_messages`/`recovery_gaps_hours`, not a new table (a client has a handful of
  flows, not thousands of rows). Shape:
  ```json
  [{
    "id": "fl_...", "name": "Abandoned Cart Nudge", "active": true,
    "trigger": {"type": "no_reply", "no_reply_hours": 24},
    "segment": {"stage": ["Hot Lead"], "tags_any": []},
    "steps": [
      {"type": "wait", "hours": 2},
      {"type": "send_whatsapp_dm", "message": "Hey {name}, still around?"}
    ],
    "stats": {"enrolled": 12, "completed": 4}
  }]
  ```

**Leads table** (`mvg6rcw0ia5qqrx`) — one new field, **auto-created at runtime** the first time
the engine tick touches a client (no manual NocoDB step needed, unlike the Email module's fields):
- `flow_state` (Long text, JSON) — per-lead progress, keyed by flow id:
  `{"fl_...": {"step": 1, "next_at": "2026-...", "enrolled_at": "2026-...", "status": "active"}}`.
  `status` is one of `active` / `done` / `exited` (opted out, handed over, or hit a terminal Stage
  mid-flow). Mirrors `recovery.js`'s `ensureRecoveryFields()` pattern, just issued through this
  file's own `ncFetch`/master-token helper (`ensureFlowStateField`) instead of a raw per-client
  token fetch.

### Backend (`cloudflare-worker/worker.js`)
- Routes, all session-gated via `requireSession`/`payload.cid` (the same "derive the client from
  the session" pattern the Email module uses):
  - `GET/POST/PATCH/DELETE /automations/flows` — CRUD on one client's `automation_flows` array.
    `PATCH` with only `{id, active}` just flips pause/resume without re-validating steps; touching
    `name`/`trigger`/`segment`/`steps` re-validates the whole shape (`validateAutomationFlow`).
  - `GET /automations/audience-preview` — same shape as `handleEmailAudiencePreview`, minus the
    email-specific clauses (a WhatsApp-only flow shouldn't require an email address).
  - `POST /automations/flows/enroll` — the one enrollment path triggered by an explicit request
    instead of the tick (mirrors the Email module's send-init vs. its cron-free send-one loop):
    resolves the flow's segment, skips leads already enrolled/opted-out/terminal, and tags each
    matching lead's `flow_state` with `{step:0, next_at:now, status:'active'}`.
- **`runAutomationFlowsForAllClients`** — a Cron Trigger tick (`*/15 * * * *`, added to
  `wrangler.toml`'s existing `[triggers]` list alongside the daily health check and the Shopify
  abandoned-cart sweep), not a browser send-loop: a flow's `wait` steps can span hours or days, and
  nothing guarantees the tab that built the flow stays open that long — the same reason
  `recovery.js`/the classic follow-up ladder are cron-driven instead of loop-driven. Each tick:
  auto-enrolls new matches for `new_lead`/`stage_enter`/`no_reply` triggers, then advances every
  already-enrolled lead whose `next_at` has passed, running consecutive non-`wait` steps in one
  pass (`advanceFlowLead`) until it hits the next `wait` or the end of the flow.

### Frontend (`frontend/broadcast.html`)
New "⚡ Automations" tab: a flow list (name, trigger, step count, Active/Draft badge, enrolled/
completed counters) and a flow editor (trigger picker, Stage/tag audience chips reusing the same
chip pattern as `email-marketing.html`'s segment builder, a live audience-count preview, and a
drag-reorderable step list with an inline mini-form per step type). No new library — reordering
uses native `draggable`/`dragover`/`drop` events on the step cards.

## Meta Ads Conversions API (CAPI) module — lead-quality reporting
Feeds CRM lead-quality signals (captured → qualified/disqualified → booked) back to Meta via
server-side Conversions API calls, so ad delivery optimizes for real conversions instead of just
WhatsApp message volume. Built as plain Worker code, same pattern as the Email Marketing module.

### Schema — Clients table (`mxl33bg4wi70fqj`)
- `meta_pixel_id` (Single line text) — the Meta Pixel/Dataset ID from Events Manager.
- `meta_capi_token` (Single line text) — a Conversions API access token generated for that Pixel
  (Events Manager → Data Sources → Pixel → Settings → Conversions API → Generate Access Token).
  A true secret, like `resend_api_key`: stripped by `safeClient()` so it never reaches the
  browser, and only ever written server-side via `/meta/capi/config` — never through the generic
  `/nocodb/` passthrough the dashboard uses for its own Clients row.
- `meta_ad_account_id` (Single line text) — added for the Meta Ads ROI Report below. Not a secret
  (no `safeClient()` stripping needed) — it's just an account identifier, same sensitivity as
  `meta_pixel_id`.

### Worker routes (`cloudflare-worker/worker.js`)
- `POST /meta/capi/config` — session-gated, writes `meta_pixel_id`/`meta_capi_token`/
  `meta_ad_account_id` (token only if a non-empty value was submitted — same "leave blank to keep
  the current value" pattern as `/email/client`'s `resend_api_key`).
- `GET /meta/capi/status` — session-gated, returns `{connected, pixel_id, ad_account_id,
  ads_read_configured}` — never the token. `ads_read_configured` is a separate flag from
  `connected`: CAPI working (`connected`) doesn't guarantee the same token also has the `ads_read`
  permission the ROI Report's spend call needs.
- `POST /meta/capi/lead-event` — session-gated, body `{lead_id, event, value?, currency?}`. Looks
  up the lead (ownership-checked against the session's `cid`, same pattern as
  `handleBroadcastFollowupSend`), hashes its `Email`/`Phone` (SHA-256, per Meta's spec) into
  `user_data.em`/`user_data.ph`, and posts to `https://graph.facebook.com/v18.0/{pixel_id}/events`
  with `action_source:'business_messaging'` + `messaging_channel:'whatsapp'` (Meta's documented
  shape for click-to-WhatsApp CAPI events). No-ops with `{ok:true, skipped:true}` if the client
  hasn't connected a Pixel/token — this is best-effort secondary reporting, never a hard
  dependency for core lead CRUD.
- `event` is one of a fixed small set (`META_CAPI_EVENTS`): `lead` → standard `Lead`, `qualified`/
  `disqualified` → custom `QualifiedLead`/`DisqualifiedLead` (negative signal matters to Meta's
  optimization too, not just positive), `booked` → standard `Schedule` (fired when a lead reaches
  a `TERMINAL` pipeline stage — `consultation_booked`/`visit_booked`/`appt_booked`/
  `human_handover` — the one cross-industry "real conversion" concept this CRM already has, since
  pipeline `Stage` names themselves are freeform per client via the stage builder).

### Frontend (`dashboard.html`)
- New "Meta Ads (Conversions API)" card in the Integrations tab (`cfgMetaPixelId`/
  `cfgMetaCapiToken` inputs, `saveMetaCapiConfig()`/`loadMetaCapiStatus()`), same shape as the
  existing Resend card.
- `sendLeadCapiEvent(leadId, event, extra)` — fire-and-forget POST to `/meta/capi/lead-event`,
  errors swallowed (never blocks the UI for what is secondary reporting).
- `reportLeadQualityChange(leadId, before, after)` — compares a lead's before/after `Score`/
  `Stage` and calls `sendLeadCapiEvent` for the relevant transition. Wired into the three places
  a lead's Score or Stage actually changes: `saveLead()` (Add/Edit modal — also fires the initial
  `lead` event on create), `kbDrop()` (kanban drag-to-stage), and `patchDetailField()` (the
  Score dropdown in the lead detail pane).

### Known limitation
No `ctwa_clid` (Click-to-WhatsApp ad click id) capture — WhatsApp inbound messages are handled by
the n8n engine, outside this repo, so matching relies on the lead's phone/email only. Match
quality/attribution would improve if the n8n workflow captured `ctwa_clid` from the first-message
webhook's referral payload and stored it on the Lead row for `sendMetaCapiEvent()` to forward
(unhashed, per Meta's spec) alongside `user_data`.
Note this limitation is specific to the n8n engine path — a client migrated onto the Cloudflare
Ecom Conversation Engine (below) receives the raw Chatwoot webhook payload directly and could
capture `ctwa_clid` the same way, if wired up; not done here since it's out of scope for the
migration itself.

## Meta Ads ROI Report (`frontend/dashboard.html` — now the 📈 Reports page's Marketing tab)
Ad spend against conversions and revenue this CRM already tracks, last 6 months. **Originally**
built as its own view inside the Team page (a local tab toggle, `showTeamView()`); **since
promoted** into the dedicated 📊 Reports page (see "Reports page" section below) alongside seven
other report tabs — the underlying computation described here is unchanged, only its container
ids and page location moved (`renderMetaRoiReport()` → `renderReportsMarketing()`).

**Why this needed a second Meta credential, not just CAPI**: Conversions API is one-way — it only
ever *sends* events to Meta so ad delivery optimizes; it has no endpoint that returns spend or
campaign data back. Ad spend comes from a completely different API, Meta's **Marketing API** (Ads
Insights), which has no concept of a Pixel at all — only an **Ad Account**. `meta_ad_account_id`
(schema table above) is the new field this needed; the same `meta_capi_token` is reused for the
Insights call rather than asking for a third credential, since a System User token commonly has
both `ads_management`/CAPI and `ads_read` granted together — but isn't guaranteed to, which is
exactly what `ads_read_configured` (see `/meta/capi/status` above) exists to signal.

**Known limitation, honestly scoped**: this is a **blended/account-level** ROI, not true
per-campaign attribution. Without `ctwa_clid` capture (see the CAPI module's own "Known
limitation" above), there's no way to know *which* leads actually came from a Meta ad vs. organic/
referral/other channels — so "conversions" here means every lead captured in the period, and spend
is the whole ad account's spend, not spend-per-campaign matched to its own leads. That's still a
directionally useful "are we profitable on ads overall" number (what many small businesses actually
track as blended ROAS), just not a precise per-campaign breakdown — building that would need
`ctwa_clid` capture wired into the engine first, a separate, larger piece of work.

### Schema — Cloudflare D1 (`env.DB`, table `meta_capi_events` — see
`migrations/0003_meta_capi_log.sql`)
`sendMetaCapiEvent()` previously fired-and-forgot every CAPI call with no record anywhere — this
logs every **successful** send (never skips/failures) to D1: `client_id`, `event`, `lead_id`,
`sent_at`. This is what the report's "CAPI Events Sent to Meta" table reads from — an audit trail
letting a client sanity-check CAPI is actually firing, distinct from the CRM's own conversion
counts (which come from `allLeads`, not this log).

### Worker routes (`cloudflare-worker/worker.js`)
- `GET /meta/ads/spend-trend?months=6` — session-gated. Calls Meta's Ads Insights endpoint
  (`GET /act_<ad_account_id>/insights?time_increment=monthly`) for one combined call returning
  every month's spend at once, rather than one request per month. Returns `{connected:false,
  months:[]}` (not an error) if `meta_ad_account_id`/`meta_capi_token` aren't set, or if Meta
  rejects the call (e.g. the token lacks `ads_read`) — best-effort, same "never a hard dependency"
  shape as the rest of this file's optional integrations.
- `GET /meta/capi/log-trend?months=6` — session-gated. Buckets `meta_capi_events` by month
  (`YYYY-MM`, matching both the spend trend's own key shape and `closedMonthKey()`'s convention in
  Revenue Forecast) and counts per event type.

### Frontend (`dashboard.html`)
- Integrations tab's existing "Meta Ads (Conversions API)" card gained an **Ad Account ID** field
  (`cfgMetaAdAccountId`) and a note explaining the CAPI-can't-report-spend distinction above.
- `renderMetaRoiReport()` — fetches both new routes in parallel, computes conversions/leads/revenue
  per month **client-side from `allLeads`** (reusing `isWonLead`/`closedMonthKey` from Revenue
  Forecast — no reason to duplicate that logic server-side when the frontend already has every
  lead loaded), and joins them by month key. Stat tiles (Total Spend, Total Revenue, ROAS, Cost/
  Lead, Cost/Booking) and the monthly table show spend-dependent figures as `—` rather than hiding
  the whole report when `ads_read` isn't connected.

## Meta Ads Automation module (`frontend/dashboard.html` — Reports page's 🤖 Ads Automation tab)
A **standalone module**, separate from the read-only Marketing/ROI tab above — genuinely
write-capable against Meta's **Marketing API**: it creates/syncs Custom Audiences and moves real
campaign budget, not just reads spend. Manual-only in this first version: every action fires only
when a client clicks "Run now" — nothing here runs on a cron yet.

**Why cost-per-lead, not lead mood, drives the Budget Shifter**: the original idea was to shift
budget from campaigns generating Cold leads to campaigns generating Hot ones. That needs each lead
attributed to the Meta campaign that produced it — which this CRM can't do yet (no `ctwa_clid`
capture, same limitation as the CAPI module above). Instead, the Budget Shifter reads
**cost-per-lead straight from Meta's own Ads Insights**, per campaign — a real signal Meta already
computes, that still rewards efficient campaigns over wasteful ones, just not mood-weighted. If
`ctwa_clid` capture is ever wired into the engine, a true mood-weighted shifter becomes possible
without changing this module's plumbing — just the scoring function inside
`metaFetchCampaignPerformance`.

### Schema — Clients table (`mxl33bg4wi70fqj`)
Add these columns before using the module (same "add this column" pattern as `monthly_ad_budget`
above) — none are secrets, they reuse the existing `meta_ad_account_id`/`meta_capi_token` pair for
all API calls:
- `meta_automation_config` (Long text) — JSON blob of guardrails (`budget_shift_pct`,
  `budget_shift_floor`, `budget_shift_min_spend`, `lookalike_country`, `lookalike_ratio`,
  `fatigue_frequency_threshold`, `fatigue_ctr_drop_pct`), defaults in
  `META_AUTOMATION_CONFIG_DEFAULTS` (worker.js) if unset.
- `meta_suppression_audience_id` (Single line text) — Custom Audience id, created once by
  `metaEnsureCustomAudience` and reused on every later suppression run.
- `meta_hotleads_audience_id` (Single line text) — same, for the Lookalike source audience.
- `meta_lookalike_audience_id` (Single line text) — the Lookalike Audience itself, created once.

### Schema — Cloudflare D1 (`env.DB`, table `meta_ads_automation_runs` — see
`migrations/0044_meta_ads_automation.sql`)
One row per "Run now" click, success or failure: `client_id`, `automation`
(`suppression`/`lookalike`/`budget_shift`/`fatigue`), `status` (`ok`/`error`), `summary` (short
human string shown in the Run History table), `detail_json` (full result, incl. errors),
`created_at`. Same "audit trail of what actually happened" reasoning as `meta_capi_events`.

### Worker routes (`cloudflare-worker/worker.js`)
All session-gated, all return `{error:...}` with a clear message (never a silent no-op) if
`meta_ad_account_id`/`meta_capi_token` aren't set.
- `GET /meta/automation/config` — `{connected, config, suppression_audience_id,
  hotleads_audience_id, lookalike_audience_id}`.
- `POST /meta/automation/config` — body `{config:{...}}`, merges + clamps each guardrail to a sane
  range server-side (e.g. `budget_shift_pct` 1-50) before saving.
- `GET /meta/automation/runs?automation=&limit=` — recent rows from `meta_ads_automation_runs`.
- `POST /meta/automation/suppression/run` — **Dead Lead Suppression Sync**. Pulls leads where
  `Stage='lost'` or `Score='Cold'` (`reportIsLostLead`/`Score` — a heuristic, not a wired pipeline
  concept, since `Stage` names are freeform per client), hashes `Email`/`Phone` the same way CAPI
  does (`capiHashEmail`/`capiHashPhone` — SHA-256, lowercase+trim / digits-only), and syncs them
  into the suppression Custom Audience via Meta's `/customaudiences` (create-once) and `/users`
  (add) endpoints.
- `POST /meta/automation/lookalike/run` — **Lookalike Auto-Refresh**. Same sync mechanism, sourced
  from `Score='Hot'` or won leads, into the Hot Leads audience; creates the Lookalike Audience
  (`subtype:'LOOKALIKE'`, `lookalike_spec` with the configured country/ratio) the first time only —
  Meta has no "recompute now" endpoint, it recomputes a lookalike's composition on its own schedule
  as the source audience changes, so "refresh" here means keeping the source topped up.
- `GET /meta/automation/budget-shift/preview` — **read-only**. Calls
  `metaFetchCampaignPerformance` (Ads Insights at `level=campaign`, last 7 days, `spend` +
  `actions` filtered to any `action_type` matching `/lead/i`) for every ACTIVE campaign with a
  daily budget, computes cost-per-lead, and — if one campaign's cost-per-lead is >15% worse than
  the group average and there's a clear best campaign to move it to — proposes moving
  `budget_shift_pct`% of the worst campaign's budget to the best one, floored at
  `budget_shift_floor` and only considering campaigns with ≥ `budget_shift_min_spend` spend in the
  window. Returns the full campaign table either way so the client can see the numbers behind the
  (non-)proposal.
- `POST /meta/automation/budget-shift/apply` — body `{shifts:[...]}`, the **exact array the client
  got back from `/preview`**, echoed back once the client confirms. Re-validates the floor/max-shift
  guardrails server-side against the numbers in the payload (never trusts the browser) before
  POSTing each campaign's new `daily_budget` (in the account's minor currency unit — see below) to
  Meta.
- `GET /meta/automation/fatigue/check` — **read-only, no Meta writes**. Pulls `level=ad` Insights
  for the last 7 days and the 7 days before that, flags any ad whose `frequency` crosses
  `fatigue_frequency_threshold` or whose `ctr` has dropped ≥ `fatigue_ctr_drop_pct`% vs. the prior
  window.

**Known simplification**: `daily_budget` is divided/multiplied by 100 when reading/writing (Meta
returns/expects budgets in the account's minor currency unit — cents — for virtually every
currency, INR/AED included). Not adjusted for the small set of zero-decimal currencies (JPY, KRW,
etc.) — would need a per-currency lookup table if a client ever runs one of those ad accounts.

### Frontend (`dashboard.html`)
- `renderReportsAdsAutomation()` — four cards (Suppression, Lookalike, Fatigue Check, Budget
  Shifter) plus a Guardrails settings form and a Run History table, all under the new `🤖 Ads
  Automation` sub-tab (`data-reports="adsauto"`) next to Marketing.
- `runMetaAdsAutomation(kind)` — shared handler for the three simple one-click actions
  (suppression/lookalike/fatigue), disables its button while in flight, shows the result inline,
  and refreshes the Run History table.
- `previewMetaBudgetShift()` / `applyMetaBudgetShift()` — the Budget Shifter's two-step flow.
  Preview renders the campaign table and (if any) the proposed shift with an **Apply** button;
  the exact `shifts` array from the preview response is held in `_pendingBudgetShifts` and POSTed
  back unmodified on Apply — the frontend never invents or edits shift numbers itself.
- `saveMetaAdsAutomationConfig()` — saves the Guardrails form to `/meta/automation/config`.
- Integrations tab's existing "Meta Ads (Conversions API)" card gained a note that this module
  reuses the same token but additionally needs `ads_management`.

## Reports page (`frontend/dashboard.html` — 📈 Reports tab; `feat_reports_enabled`)
A dedicated top-level nav tab (promoted out from under Team, which used to have a single-report
"📈 Reports" sub-view — see the Meta Ads ROI Report section above) with eight sub-tabs, one per
report area requested: Overview, Sales, Team, Marketing, Ads Automation, WhatsApp, Shopify, Product,
SaaS, SEO, Scheduled Reports. Same
sub-nav/lazy-load convention as Recruit/Appointments/Hospitality (`renderReports()` →
`renderReportsSubPage(page)`, a `.hosp-tab`/`data-reports` sub-nav — reusing that CSS class rather
than inventing a near-identical fourth one — one shared `#reportsContent` container). Toggleable
like the other Dashboard Tabs (`feat_reports_enabled`, Settings → Modules → Dashboard Tabs).

Every sub-tab fetches/computes fresh on each visit rather than sharing a preload+cache step —
none of the eight is expensive enough to justify the coordination Hospitality's units/bookings
cache needs.

### Sales / Team — reused computation, new container ids, no new backend
`renderReportsSales()`/`renderReportsTeamReport()` are second copies of Revenue Forecast's and
Team Performance's per-agent table's own computation (same `allLeads`-driven logic,
`isWonLead`/`isLostLead`/`closedMonthKey`/`getTeamMembers`/`getTasksState`), targeting this page's
own container ids (`reportsSalesStats`/`reportsSalesTrend`/etc., `reportsTeamStats`/
`reportsTeamTable`) instead of the Team page's. Deliberately a second copy rather than a shared-id
refactor of the already-live Team page functions — safer (zero risk of regressing a working
feature) given how tightly `renderRevenueForecast()`/`renderTeamPerformance()` are bound to their
own hardcoded ids. The Team page itself is untouched and still shows the same content.

### Marketing — Meta Ads ROI (moved, see its own section above) + Budget
Budget vs. actual spend for the current month. `monthly_ad_budget` is a plain new CLIENTS field
(Number) — saved directly via `patchClient()` like every other simple settings field (e.g.
`deal_currency`), no new Worker route needed. Compared against the current month's Meta spend
(already fetched for the ROI report above it) as a simple progress bar, red past 100%. Add this
column to CLIENTS before using it (same "add this column" pattern as every other new field this
session).

### WhatsApp — `GET /reports/whatsapp?days=30` (`handleReportsWhatsapp`, worker.js)
Surfaces `ENGINE_ANALYTICS_TABLE` (`engineLogAnalytics`, one row per real inbound message — see
"Conversation Engine" above), which had been **write-only** since it was added: no route anywhere
read it back until this one. Returns message volume (daily buckets), intent breakdown, route
breakdown, average bot response time (`ResponseMs`), and error rate, over the requested window
(max 90 days). Capped at 5 NocoDB pages / 1000 rows for a bounded worst-case cost on a busy client
— a client sending more than ~1000 messages in the window sees an undercount (`capped:true` in the
response) rather than an ever-growing per-request bill. Fine for a trend/breakdown report; would
not be fine for anything billing-accuracy-sensitive (nothing here is).

### Ecommerce — `GET /shopify/analytics` (`handleShopifyAnalytics`, worker.js; tab labeled
"🛍️ Ecommerce" in the UI — route/function names kept for history, see below)
**Bug fixed**: this originally required Shopify specifically connected (`shopify_shop_domain`) to
show anything at all — a client using only the built-in storefront checkout (`onshope.com`,
`handleEcomPublicOrder`) got an empty "connect Shopify" wall despite having real orders sitting in
the exact same Ecommerce Orders table `syncShopifyOrderToEcom` (Shopify) and
`handleEcomPublicOrder` (built-in storefront) both write to. Every order source lands in the same
table, so the report now only gates on **whether an orders table resolves at all**
(`has_orders_table` — i.e. the Ecommerce module is set up), never on Shopify specifically.
`shopify_connected` is still returned, but purely as an optional "also connect Shopify to
auto-sync those orders too" nudge shown *alongside* the real data, not a wall in front of it.
- **Revenue trend/order count/AOV** come from the Ecommerce Orders table's `total` field (always
  present on any order regardless of source, cancelled orders excluded) — no new schema needed.
- **Top products** prefer a new `line_items_json` column on that same orders table (Long text,
  JSON array of `{title, quantity, price, sku}`), populated by `syncShopifyOrderToEcom()`
  (Shopify-synced orders only — the built-in storefront's `handleEcomPublicOrder` only ever
  creates one line per order and doesn't populate it) alongside the pre-existing flattened `items`
  text column (kept unchanged — `items` is what `ecom.html`'s own Orders table already renders,
  and every order source populates it). Orders with no `line_items_json` fall back to best-effort
  parsing that flattened `items` string ("2x Product Name" lines) — quantity-only, since the
  flattened string never carried a per-line price. This means per-product *revenue* only fully
  covers Shopify-synced orders; an accepted, honestly-scoped reporting-only gap (same tradeoff
  class as every other retrofitted-field limitation in this file) — quantity still shows for every
  order source.
- **Cart abandonment rate** is Shopify-only (the `shopify_checkouts` table's `completed` lifecycle,
  already tracked by `sweepAbandonedShopifyCheckouts`) — the built-in storefront has no abandoned-
  checkout concept of its own, so this stays `—` for a Shopify-less client rather than guessing.

### Product — `GET /reports/products` (`handleReportsProducts`, worker.js)
Two independent sources, whichever modules a client actually has:
- **Services** (Appointment Booking module) — bookings grouped by `service_id`, joined against
  that service's currently-listed price. Only `confirmed`/`completed` bookings count as real
  revenue (`requested`/`cancelled`/`no_show` never converted). Revenue is
  booked-count × list price — an approximation, since nothing in the Appointments module tracks a
  per-booking custom/discounted amount anywhere.
- **Top products** — reuses `handleShopifyAnalytics`' own top-products aggregation wholesale
  (calls it server-side rather than re-scanning the same orders table twice) — covers the whole
  Ecommerce module (built-in storefront + Shopify), same as the Ecommerce tab above, not
  Shopify-only despite the field's internal name.
Renders an empty state if a client has neither module's data yet.

### SEO — Google Search Console OAuth + `GET /reports/seo` (worker.js)
The one report needing its own new external connection — this repo previously had **zero**
website/SEO data source of any kind (no Search Console, no GA4, no site analytics). One-click
OAuth, same shape as the Shopify module's connect flow:
- **`signOauthState`/`verifyOauthState`** (renamed from `signShopifyState`/`verifyShopifyState` —
  the HMAC-sign-a-`{cid,exp}`-through-the-redirect logic was never Shopify-specific, just named
  that way since Shopify was the first OAuth connection built; now shared by both) carry the
  client id through Google's redirect round-trip with no server-side session store, same as
  Shopify's own `state` param.
- **New CLIENTS fields**: `gsc_refresh_token` (a true secret — stripped by `safeClient()`, which
  now also exposes a `gsc_connected` boolean the same way it does `meta_capi_connected`),
  `gsc_site_url` (the chosen Search Console property, e.g. `https://example.com/` or
  `sc-domain:example.com`), `gsc_connected_at`.
- **New secrets**: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` — a Google Cloud OAuth 2.0 Client
  (Web application type) with this Worker's `/gsc/oauth/callback` URL as an authorized redirect
  URI, and the Search Console API enabled on that Cloud project. One shared OAuth app for all
  clients (each connects their own property through it), same pattern as `SHOPIFY_API_KEY`.
- **Routes**: `POST /gsc/oauth/start` (returns Google's consent URL, `access_type=offline` +
  `prompt=consent` so a refresh_token is always issued, even on a reconnect), `GET
  /gsc/oauth/callback` (browser redirect target — exchanges `code` for tokens, stores
  `gsc_refresh_token`, redirects back to `?client=<id>&gsc=connected`, same "no frontend JS
  listens on this response" shape as Shopify's callback), `GET /gsc/sites` (lists verified
  properties on the connected Google account, for the frontend's picker — an account can have
  several), `POST /gsc/site` (saves the chosen one), `POST /gsc/disconnect`.
- **`gscGetAccessToken()`** exchanges the stored refresh_token for a fresh access_token on
  **every** call (Google access tokens expire in ~1h; this Worker is stateless per-request
  anyway) — no caching, same tradeoff as every other per-call external token exchange in this
  file.
- **`GET /reports/seo`**: calls the Search Analytics API (`searchAnalytics/query`) three times in
  parallel — `dimensions:['date']` for the trend, `['query']`/`['page']` (rowLimit 10 each) for
  top queries/pages — over the 28 days ending **3 days ago**, not today: Search Console's own data
  has a ~2-3 day processing lag (Google's documented latency), and requesting a fresher end date
  just returns rows of zeros for days it hasn't finished processing yet.
- **Frontend flow** (`renderReportsSeo()`): not-connected → "Connect Google Search Console" button
  (`connectGsc()`, navigates the whole tab to the OAuth URL, same as Shopify's connect flow — not
  a popup) → connected-but-no-site-chosen → a property picker (`saveGscSite()`) → full report
  (stat tiles, daily click trend, top queries/pages tables, a Disconnect link). `showApp()`'s
  `gscParam` handling mirrors the existing `shopifyParam` one for the `?gsc=connected`/
  `?gsc=error` redirect.

## Frontend modal convention — every `.modal` must be a direct child of `<body>`
Bug fixed: several popups across the app (the Human Deals "close this deal" outcome modal, the
Coach panel, and both Hospitality Booking/day-picker modals) were completely unclickable — the
modal visibly opened, but clicking anything inside it did nothing, because `#overlay` (the
dimmed backdrop, `onclick="closeAllModals()"`) was silently intercepting every click instead.

Root cause: `#overlay` and the ~30 working `.modal` divs all live as **direct children of
`<body>`**, sibling to `#app`, so `#overlay`'s `z-index:100` vs. a modal's `z-index:101` decide
stacking directly. The four broken modals, though, were physically written *inside* `#app`/
`#pages` — nested next to the page content they belonged to (Human Deals, Hospitality) instead of
down with the rest of the top-level modal markup. Once a modal is nested inside another element,
its `z-index:101` only competes against siblings *within that nested container's own stacking
context* — compared against `#overlay`, the entire `#app`/`#pages` subtree paints as one unit at
whatever (unindexed) level its container sits at, which loses to `#overlay`'s explicit
`z-index:100` regardless of the modal's own `z-index` value deep inside it. Confirmed via a
headless-browser click test (Playwright reported "`#overlay` intercepts pointer events" on a
trial click) rather than guessed from reading the CSS — z-index numbers alone looked correct.

**Fix**: moved all four `.modal` divs (`modalHdRemove`, `modalCoach`, `modalHospBooking`,
`modalHospDay`) to be direct children of `<body>`, immediately after `#overlay`, matching where
every other modal already lives. **Any new modal added in the future must go there too** — not
nested inside a `.page` div, however locally convenient that seems while writing it — or it will
silently reproduce this exact bug.

## Conversation Engine (`POST /engine/webhook/<secret>`) — replaces the n8n engine for every industry
Every client, regardless of `industry`, now runs on this one Worker endpoint instead of n8n — it
does the entire job the external n8n workflow (`engine.json`, "Leadvyne · Engine v3" — not in this
repo) used to do: resolve the tenant, look up/create the lead, turn media into text (including real
voice transcription — see below), classify intent/sentiment/objection, run the `flow_json` state
machine (FAQ / qualifying questions / objection handling / human handover), send the reply via
Chatwoot, and upsert the LEADS row + analytics — plus the order/booking-signal auto-send that used
to be a second, separate webhook (see "Industry-aware FAQ grounding" below). n8n is no longer in
the loop for any client once they're cut over; `handleEngineWebhook` has no industry gate.

**Gemini-first, OpenRouter-fallback — every LLM call in the engine (`GEMINI_API_KEY`):** every
step of a turn that calls an LLM now tries the shared Gemini credential first and only falls back
to the client's own `openrouter_key`/`model` if Gemini is unset or fails — intent/sentiment/
objection classification (`engineClassifyIntent`), image description
(`engineGeminiDescribeImage`), and — the one that used to be the exception — **the main reply
agent itself, `engineCallLlm`**, which generates every FAQ/objection/product-enquiry reply across
every client and industry. Voice transcription (`engineGeminiTranscribeVoice`) is the one
exception to this fallback pattern — deliberately Gemini-only, no OpenRouter backup (see below).
- `engineCallLlm` was OpenRouter-only until this change: no Gemini path at all, so it was a single
  shared point of failure for every client's core reply text, and — worse — any failure there
  (a thrown fetch, a non-OK response, an empty response body) was swallowed completely silently,
  collapsing to a generic `"One moment 🙏"` placeholder with **zero logging**, indistinguishable in
  Chatwoot from a real "let me check" delay. A real production incident (every client's bot
  replying "One moment 🙏" simultaneously, with no way to tell why) is what prompted this fix.
  `engineCallLlm` now: tries Gemini (`engineGeminiGenerate`) first, then falls back to OpenRouter
  using the client's own key/model exactly as before (deliberately *not* forced onto a hardcoded
  Gemini-via-OpenRouter call the way `engineGeminiGenerateWithFallback`'s fallback leg is — a
  client who chose a specific model on purpose still gets it as the safety net), and only logs via
  `reportOpsError` if **both** layers fail — the one moment a real customer is actually about to
  receive the generic fallback, matching this file's existing principle (see "Error monitoring"
  below) that total failure is worth alerting on even though single-layer fallbacks elsewhere
  aren't.
- Image descriptions (`engineResolveUserText`'s image branch) are the same fix, same shape:
  `engineGeminiDescribeImage` (direct Gemini vision) tried first, the existing OpenRouter vision
  call (client's own key/model) as fallback — closing the last OpenRouter-only LLM call in the
  turn-processing path.
- **`engineCallLlm`'s direct-Gemini call now uses a dedicated `ENGINE_REPLY_MODEL`
  (`gemini-2.5-flash`), not the shared fast/cheap `ENGINE_GEMINI_MODEL` (`gemini-2.0-flash`) used
  for the classifier/translation calls.** Real observed failure: a customer asked about a free-trial
  offer that was explicitly written in that client's own `main_prompt` (so the correct answer was
  right there in the system prompt) and still got told there wasn't one — the same accuracy gap
  already fixed for voice transcription (see `ENGINE_TRANSCRIBE_MODEL`), just showing up in the
  reply itself instead. `engineGeminiGenerate` now takes an optional `opts.model` (defaults to
  `ENGINE_GEMINI_MODEL` everywhere else — classifier/translation calls are unaffected, since a
  slightly-off intent guess or translation is a smaller miss than the actual answer being factually
  wrong).
- **Thinking disabled for both `gemini-2.5-flash` calls (`ENGINE_REPLY_MODEL`,
  `ENGINE_TRANSCRIBE_MODEL`) — a follow-up fix to the model upgrade above.** Real observed failure:
  a brand-new lead's first-touch reply came back as `"Hello! Leadvyne is an AI-powered"`, cut off
  mid-sentence, sent to the customer as-is. Root cause: Gemini 2.5 models have "thinking" (internal
  reasoning) on by default, and Google counts those invisible thinking tokens against the *same*
  `maxOutputTokens` budget as the visible reply — a 2.5 model can burn 90-98% of a short reply's
  token budget on reasoning alone, truncating the actual visible text wherever the budget runs out.
  None of this engine's calls need extended reasoning (a classifier verdict or a short WhatsApp
  reply isn't a chain-of-thought task), so `engineGeminiGenerationConfig` now sets
  `thinkingConfig:{thinkingBudget:0}` whenever a 2.5 model is in use (`model.startsWith('gemini-2.5')`)
  — a no-op for `gemini-2.0-flash`, which has no thinking mode. `engineGeminiTranscribeVoice` sets
  the same flag directly on its own request body (it doesn't route through `engineGeminiGenerate`,
  since it needs to attach `inline_data` audio).
- **`engineStripHallucinatedToolCode` strips hallucinated tool-call pseudocode out of every
  `engineCallLlm` reply before it reaches a customer.** Real observed failure: a reply went out as
  literal `print(get_product_images(category="SHIRT", ...))` lines followed by the actual intended
  text. Nothing in this file ever declares a `tools`/function-calling schema to Gemini or
  OpenRouter, so this was never a real function call to parse — the model imagined its own
  scaffolding (models trained on agentic/tool-use data will sometimes narrate a fake
  ` ```tool_code``` ` block even with no tools actually offered) and it leaked straight into the
  reply text. Strips any fenced ` ```tool_code```/```python```/```json``` ` block and any bare
  `identifier(args)`-only line (no real WhatsApp reply looks like that — a genuine parenthetical
  like "10am to 6pm)" always has a space before the `(`, which the pattern requires *not* having).
  Applied in `engineCallLlm` (both the Gemini and OpenRouter legs), the one chokepoint every FAQ/
  objection/product-enquiry reply already routes through. Backed by a matching system-prompt
  instruction ("never code, pseudocode, a function/tool call, or JSON — you have no tools to call")
  added to `engineBuildFaqSystemPrompt`/`engineBuildObjectionSystemPrompt`/
  `engineBuildProductEnquirySystemPrompt`, since the prompt instruction alone isn't reliably
  followed — the strip is the actual backstop.
- **Not yet covered by this pass** (still OpenRouter-only, same single-point-of-failure shape,
  just not touched by this change): `handleAiComplete` (`POST /ai/complete`, the dashboard's AI
  Deal Coach and other assistant features), `handleAiObjectionReply` (`POST /ai/objection-reply`),
  `detectOrderSignal`, and `detectBookingSignal`. These weren't part of the incident that prompted
  this fix (none of them generate the primary customer-facing reply) and are shaped differently
  (JSON-classifier calls, not free-text generation), so converting them would be a separate,
  deliberate follow-up rather than a mechanical copy of this pattern.
- Voice notes without `GEMINI_API_KEY` set, or where the Gemini transcription call fails, still
  fall back to the same `"(sent a voice note)"` placeholder text engine.json always sent instead
  (that placeholder isn't new, only now it's a fallback rather than the only behavior).
- **Transcription is Gemini-only, deliberately no OpenRouter fallback.** An earlier revision routed
  a failed direct Gemini call through OpenRouter's OpenAI-compatible `input_audio` content part as
  a backup — that shape was never verified against a live call and was a plausible source of bad/
  garbled transcripts in its own right, not a safety net. Removed; `engineGeminiTranscribeVoice` is
  the only transcription path now.
- The media download (`engineFetchAudioBase64`) and the transcription call
  (`engineGeminiTranscribeVoice`) now report failures via `reportOpsError` instead of returning
  `null` silently — previously a transcription failure was indistinguishable from "customer just
  sent an unclear voice note," so a real bug (bad mime type, expired media URL, API error) had zero
  trace. The media fetch also strips any `; codecs=...` parameter off the downloaded file's
  `Content-Type` before handing it to Gemini as `mime_type` (WhatsApp/Chatwoot serve voice notes as
  `audio/ogg; codecs=opus`, and Gemini's `inline_data` expects a bare MIME type).
- **Reliability pass: retries, a too-short-recording guard, and an outbound audio sanity check.**
  - `engineFetchWithRetry` retries once (short fixed delay) on a thrown network error or a
    likely-transient status (429/5xx), for the pipeline's three external calls: the media download,
    the Gemini transcription call, and the Sarvam TTS call. Scoped to this one pipeline, not applied
    engine-wide.
  - `engineFetchAudioBase64` now flags a suspiciously tiny downloaded file (under 800 bytes — real
    observed case: a tap-and-release voice note showing `00:00` in Chatwoot's own player) as
    `{tooShort:true}` rather than attempting transcription on what's essentially silence/
    container-only bytes — Gemini transcribing that anyway risks hallucinating plausible-sounding
    text from noise rather than failing cleanly. `engineResolveUserText` returns a distinct
    placeholder for this case so the AI's reply naturally asks the customer to resend, instead of
    answering a fabricated transcript.
  - `engineSarvamTts` now rejects a suspiciously tiny decoded audio buffer (under 200 bytes) as a
    failure (same fallback-to-text path as every other TTS failure) rather than sending the customer
    a broken/silent "voice note."
- **Transcription accuracy fix: dedicated model + language hint.** Real-world testing (Malayalam
  voice notes) surfaced calls that succeed (no error, non-empty text) but mis-transcribe the actual
  words — two separate gaps, not a failure this engine's error reporting would ever catch:
  - `engineGeminiTranscribeVoice` now calls `gemini-2.5-flash` (`ENGINE_TRANSCRIBE_MODEL`) instead
    of reusing `ENGINE_GEMINI_MODEL` (`gemini-2.0-flash`, chosen elsewhere in this file for speed on
    the classifier/reply calls) — Gemini's own docs note 2.0 Flash trails its newer models on
    transcription accuracy specifically, a gap that's worse for lower-resource Indic languages than
    for English.
  - The transcription prompt now takes an optional language hint (`CLIENTS.language`, e.g. `'ml'`
    for a Malayalam-speaking client base) via `ENGINE_LANG_NAMES`, so Gemini isn't simultaneously
    guessing which language is spoken *and* transcribing it blind — per Gemini's docs, a language
    hint "noticeably improves accuracy on multilingual or accented audio." Framed as a soft
    expectation, not a hard lock ("expect {language} unless the audio is clearly a different
    language"), so a customer who doesn't match the client's configured default still gets
    transcribed in whatever they actually spoke.

**Voice-to-voice replies (Sarvam AI, `SARVAM_API_KEY`):** for clients with the Settings → Voice →
Voice-to-Voice Reply toggle explicitly switched on (`voice_reply_enabled='Yes'`, CLIENTS field,
opt-in — default blank/`'No'` means off). This is the only gate — deliberately not tied to
`voice_addon_active`/billing at all, so the client controls it purely via the toggle. A customer
who sends a voice note
gets a WhatsApp voice note back instead of text, mirroring their own input modality —
`engineDeliverReply` is the single dispatcher every route (human handover / qualify / FAQ /
objection / order-detected) now sends its final reply through, instead of each of those eight call
sites calling `engineSendChatwootReply`/`engineSendChatwootImageReply` directly.
- **Language-aware, reusing detection you already have.** `engineClassifyIntent` already returns a
  per-message `customerLanguage` (ISO 639-1) for every turn, voice or text — this feature doesn't
  run a second detection pass, it just maps that code to Sarvam's BCP-47 `target_language_code`
  (`ENGINE_TTS_LANG_MAP`: `en`→`en-IN`, `ml`→`ml-IN`, `hi`→`hi-IN`, `ta`→`ta-IN`, `te`→`te-IN`,
  `kn`→`kn-IN`, `bn`→`bn-IN`, `gu`→`gu-IN`, `mr`→`mr-IN`, `pa`→`pa-IN`, `or`→`od-IN`). Sarvam's TTS
  is Indic-language-focused, deliberately not treated as a catch-all — a customer whose detected
  language isn't in that map (Arabic, for instance, common in this product's UAE client base) gets
  a normal text reply instead of voice in an unsupported/mistranslated language.
- **Never speaks a link or price.** The real reply text (whatever the FAQ/objection/order-detection
  logic already composed) is never spoken verbatim — `engineBuildSpokenReply` asks Gemini to
  rewrite it as one short, natural spoken sentence, explicitly instructed to never say a URL, link,
  price, or long number out loud. Any link/price found in the real reply is instead preserved as a
  short one-line text caption on the same voice message (`engineExtractLinkPriceCaption`, simple
  regex extraction — no second AI call) — so a checkout link or a price the FAQ answer needed to
  share still reaches the customer in a form they can actually tap/copy.
- **Female voice, via Sarvam's `bulbul:v2` model** (`ENGINE_TTS_SPEAKER='anushka'`) — `engineSarvamTts`
  calls `POST https://api.sarvam.ai/text-to-speech` with the `api-subscription-key` header. Endpoint,
  header, request/response shape, and speaker name have been checked against Sarvam's live REST
  reference (`docs.sarvam.ai`). Earlier revisions of this feature hardcoded `speaker='meera'`, which
  isn't a valid `bulbul:v2` speaker (valid female voices are `anushka`/`manisha`/`vidya`/`arya`, male
  are `abhilash`/`karun`/`hitesh`) — every real Sarvam call was failing with a non-OK response and
  silently falling back to a text reply. Fixed by switching to `anushka`, `bulbul:v2`'s default voice.
- **Requests `output_audio_codec:'opus'` (Ogg/Opus), not Sarvam's default WAV.** WhatsApp's Cloud
  API only renders an audio attachment as a native, playable voice-note bubble when it's Ogg/Opus —
  a WAV attachment is either rejected outright or arrives as a generic file, not a voice note. Also
  switched `speech_sample_rate` to `16000`: Opus itself only supports 8/12/16/24/48kHz, and Sarvam's
  general-purpose 22050Hz default (valid for its other codecs) isn't a legal Opus rate.
  `engineSendChatwootAudioReply` sends the attachment as `reply.ogg` /
  `audio/ogg; codecs=opus` to match.
- **Follow-up messages are explicitly out of scope for now** — `followup-template.json` and the
  dashboard's Follow-ups feature are untouched; this only covers live conversational replies inside
  `handleEngineWebhook`, not scheduled nudges.
- **Falls back to text at every failure point** — no `SARVAM_API_KEY` configured, `voice_reply_enabled`
  off, an unsupported language, a product-image reply already in play (image and voice aren't
  combined), or the TTS call itself failing all fall straight back to
  `engineSendChatwootReply`/`engineSendChatwootImageReply`, same "customer never gets nothing"
  principle as the existing image-reply fallback.
- **AI4Bharat standby, before falling back to text.** Sarvam AI stays the PRIMARY TTS provider —
  unchanged — but `engineDeliverReply` and `handleBroadcastFollowupSend` now call a small
  `engineTtsWithFallback(env, text, langCode)` helper instead of `engineSarvamTts` directly: it
  tries Sarvam first, and only when that returns `null` (missing key, unsupported language,
  transient failure) does it try `engineAi4BharatTts` — a self-hosted AI4Bharat Indic Parler-TTS
  model running on the Marketing Studio render pipeline (`render-pipeline/lib/ai4bharatTts.js`,
  `POST /synthesize-voice-reply`, gated behind that service's own `AI4BHARAT_TTS_ENABLED`). Reuses
  the render pipeline's existing `MARKETING_RENDER_WEBHOOK_URL`/`_SECRET` Worker secrets — no new
  secret to configure on the Worker. Same scope as this app's other AI4Bharat integration (the 10
  Indic languages + English already mapped elsewhere, `AI4BHARAT_TTS_LANGS`), and same "silent
  null when unconfigured, real ops report on an actual failure" convention as `engineSarvamTts`
  itself. **Honest tradeoff**: a real self-hosted model call over HTTP to another server, not a
  fast managed API — expect real added latency (seconds, possibly tens of seconds on CPU) versus
  Sarvam, and this hasn't been verified against a live deploy (see
  `render-pipeline/README.md`'s "AI4Bharat TTS standby" section for exactly what is and isn't
  confirmed about the model itself). Falls through to the normal text reply if BOTH providers fail,
  same as before this standby existed.
- **Testing knob**: `voice_tts_provider` (Settings → Voice → 🔧 TTS Provider (testing) dropdown,
  `dashboard.html`) lets you force a specific provider per client — "AI4Bharat only" calls the
  standby directly (skipping Sarvam entirely) so you can test it against a real WhatsApp
  conversation without needing to break the shared `SARVAM_API_KEY` Worker secret, which would
  otherwise affect every client's voice replies at once. Leave on "Auto" (blank) for normal
  operation — it's purely a testing/debug override, not something a client would set day-to-day.
- **Spoken-reply rewrite has a Gemini-via-OpenRouter backup; voice-note transcription does not.**
  `engineBuildSpokenReply` calls `engineGeminiGenerateWithFallback` (direct Gemini first, then
  OpenRouter routed to a Gemini model using the client's own `openrouter_key` if Gemini is unset or
  fails) — deliberately hardcoded to a Gemini model on OpenRouter rather than the client's own
  configured `model`, since the point is "still get a Gemini-quality result", not "fall back to
  whatever model this client happens to use elsewhere". If both fail, it falls back to a plain
  regex strip of links/prices from the real reply text rather than failing the voice reply
  outright. **Voice-note transcription (`engineGeminiTranscribeVoice`) intentionally has no such
  backup** — see "Voice messages are actually transcribed" above for why the OpenRouter fallback
  that used to exist here was removed rather than kept as a safety net.

**Voice module (Settings → 🎙️ Voice, `frontend/dashboard.html`) — a dedicated sub-page, not a
card buried inside Integrations.** Previously the only voice-related setting was one card on the
Integrations page; there was no home at all for a second voice-related toggle. Voice is now its own
sub-page in the Settings sub-nav (alongside General/Channels/Integrations — `SETTINGS_GROUP`,
`navigate('voice')`), holding two independent toggles:
- **🎙️ Voice-to-Voice Reply** (`voice_reply_enabled`) — moved here unchanged from Integrations, see
  above.
- **🔁 Voice Follow-ups** (`voice_followup_enabled`, new CLIENTS field — add this column before
  using the toggle) — applies the same Sarvam voice pipeline to *scheduled* outbound messages
  instead of live replies:
  - **Classic follow-up sequence, manual "Send Next Now"** (`handleBroadcastFollowupSend`,
    `POST /broadcast/followup-send`) — when the toggle is on, tries a Sarvam voice note
    (`engineSarvamTts` + the same Ogg/Opus attachment shape `engineSendChatwootAudioReply` uses)
    before falling back to the existing plain-text send. Unlike the live-reply pipeline's
    fire-and-forget voice attempt, this is a rep clicking a button expecting real success/failure
    feedback, so a failed voice send falls through to the text send rather than silently reporting
    success to the UI — the rep still sees the true outcome. Response now also includes
    `sentViaVoice: true/false`.
  - **Automated recovery/win-back ladder** (`backend/recovery.js`, hourly cron) — same toggle,
    checked before each plain-text stage send (never for a `recovery_templates` stage — WhatsApp
    template messages aren't a voice-note content type, so those always send as the approved text
    template regardless). Since `recovery.js` is a separate Node process with no access to the
    Worker's own `SARVAM_API_KEY` secret or helper functions, the Sarvam TTS call and the Chatwoot
    audio-attachment send are natively ported into that file (`sarvamTts`/`sendVoiceMessage`/
    `extractLinkPriceCaption`) rather than shared code — keep both copies in sync if the Worker's
    speaker/codec/sample-rate choices ever change. Needs its own `SARVAM_API_KEY` env var on the
    `leadvyne-recovery` container (`backend/.env.example`, `backend/docker-compose.yml`) — the same
    key value as the Worker's secret, just configured again since it's a different deployment
    that doesn't share environment with the Worker.
  - **AI4Bharat standby, ported the same way.** `recovery.js` also has its own copy of
    `engineTtsWithFallback`/`engineAi4BharatTts` (`ttsWithFallback`/`ai4BharatTts` — Sarvam first,
    AI4Bharat standby second) since it can't import the Worker's version either. Needs
    `MARKETING_RENDER_WEBHOOK_URL`/`MARKETING_RENDER_WEBHOOK_SECRET` env vars on the
    `leadvyne-recovery` container — same values as the Worker's own secrets for the Marketing
    Studio render pipeline — left unset, this standby is silently skipped and the ladder stays
    Sarvam-or-text only, same as before it existed.
  - Both paths fall back to the ordinary text send on any failure (missing key, unsupported
    language, both TTS providers failing) — a follow-up is never skipped over a voice hiccup, same
    "customer never gets nothing" principle as the live-reply pipeline.

**Transcription accuracy: business-vocabulary hint.** `engineGeminiTranscribeVoice` now takes an
optional `vocabHint` (`engineBuildTranscribeVocabHint`) — the client's own business name plus its
`services` product/service names, capped to 15 terms — appended to the transcription prompt as
"spell these exactly as given if you hear something close to one." Real-world gap: a brand/product
name is exactly the kind of term a general-purpose ASR model most commonly mishears, since it has no
prior context for an unfamiliar word and just guesses phonetically. Not a hard constraint — the
model still transcribes whatever's actually said if it doesn't match anything in the hint.

**Fully automatic on signup — no manual Chatwoot step, for any industry.**
`engineSyncChatwootWebhook` (`worker.js`) keeps a client's PRIMARY Chatwoot webhook (the one that
decides who actually replies to the customer) pointed at `{WORKER_BASE_URL}/engine/webhook/<their-secret>` (see "Webhook authentication" below),
called from two places:
- **`handleChannelsWhatsappConnect`** — the moment a client connects WhatsApp (signup wizard or
  Settings → Channels), the engine URL gets registered on the new inbox immediately. This is the
  path every new signup goes through, so a brand-new client — any industry — never has n8n wired
  up at all.
- **`handleNocodbPassthrough`** — dashboard.html's Settings page saves most CLIENTS fields
  straight through this generic passthrough, with no dedicated per-field handler. Any successful
  PATCH to the client's own CLIENTS row re-checks the webhook as a safety net (cheap no-op if
  already correct), covering the case where `chatwoot_inbox_id` or a legacy `webhook_url` becomes
  available slightly out of order relative to other Settings saves.

`engineSyncChatwootWebhook` also cleans up: if a client still has their old n8n `webhook_url`
registered (from before this migration, or an admin-created client that went through the old
n8n-based onboarding), it's removed the moment the engine URL is confirmed present — so n8n can
never reply to the same message a second time. The separate **Auto Order-Tracking** webhook
(`handleEcomEnableOrderTracking`, pointed at `/hooks/chatwoot-message`) and anything a client
registered by hand in Chatwoot are never touched by this sync. That older webhook (and the
`/hooks/chatwoot-message` handler behind it) is now fully superseded for any client on this
engine — order-signal and booking-signal detection both happen inline on every engine turn instead
— so it's safe to leave enabled (redundant but harmless) or disable from Settings.

**Webhook authentication (`engine_webhook_secret`):** Chatwoot has no built-in webhook signing —
unlike Shopify and Cal.com (both verified elsewhere in this file, `verifyShopifyWebhookHmac`/
`verifyCalcomWebhookHmac`, against a secret the client configures on *their* side), Chatwoot's
webhook feature just POSTs JSON to whatever URL you give it: no signature header, no secret field
in its own settings UI. So the equivalent protection here is a random 192-bit per-client token
baked directly into the URL path — `/engine/webhook/<secret>` — the same URL-path-token pattern
this codebase already uses for `/calcom/webhook/<clientId>`. `engineEnsureWebhookSecret` generates
one (via `crypto.getRandomValues`, not `Math.random`) the first time `engineSyncChatwootWebhook`
runs for a client and persists it to a new CLIENTS column, and `handleEngineWebhook` rejects any
request whose path segment doesn't match a real client's stored secret before touching anything
else — so knowing a client's numeric id or `chatwoot_account_id` (both surface elsewhere already)
no longer gets an attacker anywhere near this endpoint.
- **New required CLIENTS column: `engine_webhook_secret`** (Single line text) — add this to
  NocoDB once, by hand, same as most other CLIENTS fields in this codebase; it isn't auto-created.
  Until it exists, `engineEnsureWebhookSecret` returns null and `engineSyncChatwootWebhook`
  declines to register any webhook at all (safer than registering one with a secret that can't
  actually be saved).
- **Never rotated automatically.** If you ever need to rotate a client's secret (suspected leak,
  etc.), clear their `engine_webhook_secret` field by hand and re-trigger a sync (any Settings
  save, or reconnect WhatsApp) — `engineSyncChatwootWebhook` also cleans up any stale
  `/engine/webhook/` registration under the old secret when it finds one, so there's never a
  window where both the old and new secret are simultaneously accepted... other than the accepted
  gap between clearing the field and the next sync, during which the *old* secret still works
  (nothing invalidates it server-side) — genuinely revoking a leaked secret immediately would need
  an explicit deny-list, not implemented here.
- **Defense in depth, not the actual boundary:** `handleEngineWebhook` also cross-checks the
  payload's own `account.id` against the matched client's `chatwoot_account_id` and drops anything
  that disagrees — catches a misconfigured/reused webhook, though the secret match is what's
  actually doing the security work.
- **Backfilling existing clients:** `engineEnsureWebhookSecret`/`engineSyncChatwootWebhook` only
  run when a client connects WhatsApp or saves a Settings field (`handleNocodbPassthrough`), so
  any client that hasn't touched either since this engine shipped will have no
  `engine_webhook_secret` yet. Rather than asking every such client to re-save a setting, admin.html
  has a **"🔄 Sync engine webhooks"** button (top toolbar) that calls
  `POST /admin/backfill-engine-webhooks` — walks every CLIENTS row and runs
  `engineSyncChatwootWebhook` for each one that already has Chatwoot connected. Safe to click
  repeatedly; it's the same idempotent sync, just triggered for all clients at once instead of one
  at a time. **Does not touch Chatwoot's separate Agent Bots feature** (see next paragraph) — a
  client whose bot is wired there still needs a manual fix.

**Chatwoot "Agent Bots" is a different mechanism from the Webhooks this engine manages — and a
trap left over from pre-migration setups.** Chatwoot has two unrelated ways to point an inbox at
an external URL: (1) account-level **Webhooks** (`Settings → Webhooks`, `/api/v1/accounts/:id/webhooks`),
which is everything `engineSyncChatwootWebhook` above manages, and (2) **Agent Bots**
(`Settings → Bots`), a separate object with its own `Webhook URL` field that gets assigned to an
inbox independently. If a client was set up before this engine existed (or had a bot wired up by
hand), their inbox can have an Agent Bot pointed at the old n8n URL — Chatwoot will keep sending
that bot's webhook the customer's messages regardless of what's registered under (1), so every fix
in this engine silently never reaches that client's real traffic. Neither `engineSyncChatwootWebhook`
nor the admin backfill button above touch Agent Bots at all today. To fix a client stuck like this:
open **Settings → Bots** in Chatwoot, click into their bot, and replace its `Webhook URL` with
`https://<WORKER_BASE_URL>/engine/webhook/<their engine_webhook_secret>` by hand. (Extending the
sync to also manage Agent Bots via Chatwoot's `/platform/api/v1/agent_bots` API is a reasonable
follow-up, not yet implemented.)

**Industry-aware FAQ grounding (`engineRouteFlow`'s `industryFaqRoute`),
matching engine.json's own `industry === 'ecommerce' ? 'ecom_faq' : (industry === 'travel' ?
'travel_faq' : 'faq')` split:**
- **`ecommerce`** → `engineBuildEcomContext` — live product catalog + this phone's recent order
  status, off `/ecom/products` and `/ecom/orders`.
- **`travel`** → `engineBuildTravelContext` — the Travel Agency module's own `packages`,
  `umrah_groups`, and `cars` tables (`ta_table_ids`), a from-scratch equivalent of the
  "Leadvyne · TA Context" n8n sub-workflow engine.json calls out to, which wasn't available to
  port (it isn't in this repo either).
- **Everything else** (`general`/`insurance`/`real_estate`/`healthcare`/`education`/`automotive`/
  `consultancy`) → the plain `main_prompt` + `services` + `kb_summary` grounding, no extra table
  lookups — matches what engine.json's generic "Code · FAQ prep" node already did for these
  industries, since none of them have a dedicated per-client catalog table the way ecom/travel do.

**Order-readiness now overrides the flow_json state machine's own routing entirely, not just
inside the ecom_faq branch.** Originally `detectOrderSignal` only ran once `engineRouteFlow` had
already decided the route was `ecom_faq` — meaning if the flow's own intent classification picked a
*different* route first (a scripted flow-stage transition, a qualifying question, a wouldRepeat/
POSITIVE→`faq` branch, etc.), explicit purchase intent never got a chance to be recognized at all.
Observed live: a customer was correctly shown a product's full detail card in response to a
question, then replied "Order this" — and got a scripted, unrelated flow-stage message ("Hi 👋")
instead of the order link, because engine.json-style intent classification had already routed that
turn to a flow-stage transition before order-signal detection ever ran. `detectOrderSignal` now runs
before the whole route dispatch in `handleEngineWebhook`, for every route except `drop` (opt-out/
dedup-adjacent, nothing should reply) and a `human` route caused by `routing.humanReason==='explicit'`
— a genuine "connect me to a person" ask, or real frustration, still wins even if phrased alongside
product talk. A detected signal short-circuits the entire dispatch and sends the order reply instead
of whatever `engineRouteFlow` had decided — `Stage`/`QualAnswers` bookkeeping from that decision is
left untouched (except see the `humanReason` note below), so the flow/qualification funnel resumes
normally on the next turn.

**`engineRouteFlow`'s `humanReason` distinguishes an actual request for a human from an internal
funnel-completion heuristic that only looks like one.** `route='human'` can be set for two very
different reasons: an explicit ask (`WANTS_HUMAN` intent, or `Frustrated` sentiment —
`humanReason='explicit'`), or `isFinalStage && POSITIVE.has(effIntent)` (a positive reply on the
last configured flow stage — `humanReason='final_stage_positive'`), a heuristic guess that a
completed funnel plus a positive reply probably means "ready to talk to someone," not an actual
signal the customer asked for a person. That heuristic is only as reliable as intent classification
itself, which isn't perfectly deterministic — observed live: the identical message "Red Shirt small
size" got classified as `AFFIRMATIVE` on one delivery (triggering a false "connecting you to our
advisor" reply) and correctly as a product question on an identical resend moments later. The
order-signal check above only lets a confident product match from `detectOrderSignal` (a dedicated,
catalog-aware classifier) override the `final_stage_positive` case, never the `explicit` one. When it
does override a `human` route, `routing.route` is reset to `ecom_faq` before
`engineBuildLeadUpsertBody` runs — otherwise its `isHuman` check would still force
`Stage='human_handover'`/`Handover='Yes'` onto the lead even though what was actually sent was a
product reply, not a handover.
- **`engineClassifyIntent`'s temperature was also lowered, 0.3 → 0.1**, for both the Gemini and
  OpenRouter-fallback calls — a complementary mitigation, not a fix on its own; it reduces (doesn't
  eliminate) exactly this kind of unforced classification flip between identical deliveries of the
  same message.

**`final_stage_positive` now tries the self-serve order/booking link before ever handing over to a
human — a new `'selfserve'` route.** Previously, reaching the last configured flow stage with a
positive reply always handed straight to a human with a "our team will contact you" message and no
order/trial link at all, even when one was configured (`external_store_link`/Order Link in
Integrations, or `cal_link`). `engineRouteFlow` now checks for that link first: if one exists, route
becomes `'selfserve'` instead of `'human'` and the reply is the link itself (a plain scripted send —
`handleEngineWebhook` sends it exactly like `qualify_next`, no LLM call, so the exact link always
goes out); `Stage`/`Handover` are left untouched (`engineBuildLeadUpsertBody`'s `isHuman` check is
`route==='human'`, which `'selfserve'` correctly fails). Only when no self-serve link is configured
at all does this heuristic still fall back to the original human-handover behavior
(`humanReason='final_stage_positive'`) — the genuine "nothing else the bot can offer" case. An
explicit `WANTS_HUMAN` ask or `Frustrated` sentiment (both `humanReason='explicit'`) are completely
unaffected by this — those are real requests from the customer and are always honored immediately,
link or no link. Net effect: human handover now only fires for an actual request or real frustration,
or as a last resort with no self-serve path — not as the default "funnel's done" behavior.

**A brand-new lead's very first reply now includes a short intro to what the business offers,
instead of jumping straight into a raw qualifying question or an answer with zero context.**
Gated on `isNewLead` (`!state.leadId`, computed once per webhook call in `handleEngineWebhook`), so
it only ever fires once per lead's whole lifetime:
- **`route==='qualify'`** (the very first message, before this fix): `engineBuildFirstTouchIntro`
  makes one extra LLM call — system prompt built from `main_prompt`/`services`/`kb_summary`, asked
  for one short warm sentence introducing the business followed by the exact configured first
  `qual_questions` entry on its own line. Falls back to the plain question text on any failure,
  same "never leave the customer with nothing" principle as `engineCallLlm` itself.
- **`route` is `faq`/`ecom_faq`/`travel_faq`** (qualification disabled, or the first message was a
  genuine question): `engineBuildFaqSystemPrompt` takes a new `isNewLead` parameter and, when true,
  appends one instruction telling the model to briefly work a one-sentence intro into its answer
  using the Services/Knowledge Base data already in the prompt — not a separate canned message, and
  the existing "keep replies as short as the customer's own message" instruction still applies on
  top of it.

**A matched product's photo is now sent as a real WhatsApp image attachment, not just a text
link.** `engineSendChatwootImageReply` (`worker.js`) downloads the product's `image_url` — resolving
a Google Drive share link to Drive's thumbnail endpoint first via `engineResolveDirectImageUrl`,
mirroring `store.html`'s own client-side `toImageUrl()` — and attaches it to the Chatwoot message
with the reply text as its caption, the same relay path a human agent's own attachments use. Falls
back to a plain text reply (`engineSendChatwootReply`) whenever there's no image, or fetching/
attaching one fails for any reason. Wired into the primary inline order-signal path and (separately)
`sendOrderLinkViaChatwoot`, still used by the legacy `/ecom/order-link` n8n-callable endpoint.
`sendOrderLinkNow` (direct Meta Graph API, used by that same endpoint and as
`sendOrderLinkViaChatwoot`'s own fallback when Chatwoot isn't configured) is unchanged — attaching
media via the Graph API directly needs a separate upload-then-reference flow, not implemented here.

**Enquiry vs. order intent are now handled completely differently — the order/checkout link is
never sent until real order intent is detected.** `detectOrderSignal` previously treated "asking
about a product" (a size/color/stock/price question) and "wanting to buy it" identically — both
produced the same `resolveOrderProductAndText` reply, an order link included regardless. That
conflated "interested" with "ready to buy," pushing a checkout link into every product question
whether the customer asked for it or not. `detectOrderSignal` now also classifies a `mode`,
`"enquiry"` or `"order"`, returned alongside `signal`/`sku`:
- **`mode:"enquiry"` + a matched product** → `engineBuildProductEnquirySystemPrompt` +
  `engineCallLlm` generate a natural reply from the product's full detail (name, price, color,
  size, category, stock) as context — no link, no mention of ordering beyond what the model
  naturally includes, unless `ecom_link_on_enquiry` is on (see below), in which case a checkout
  link is also included. **The product photo (`engineSendChatwootImageReply`) is sent whenever a
  product is confidently matched, independent of whether a link is included** — a customer asking
  about size/color/stock should see the actual item, not just read about it. (Briefly restricted to
  link-only sends in an earlier revision — reverted per explicit product direction: the photo isn't
  "extra" media on an enquiry reply, it's part of answering what was asked.) Originally a fixed
  template (`buildProductDetailText`, since removed) that always recited every field regardless of
  what was actually asked — observed live: a plain "Hi" got a long, salesy paragraph covering
  sizes/colors nobody asked about, and price was always volunteered even for a pure availability
  question. The system prompt now explicitly tells the model to answer only what was asked, never
  volunteer price unless asked or genuinely needed, and sound like a real person texting rather than
  a scripted pitch — the same three instructions (length, price, tone) were also added to
  `engineBuildFaqSystemPrompt` for the general FAQ/greeting reply path, which had the identical "Hi"
  → long-pitch failure.
  - **Length guidance refined, both prompts.** The original single rule — "match the customer's own
    message length" — was later observed cutting the other way: a short, specific question (how many
    days is the free trial) got an equally short reply that skipped the actual number and answered
    wrong, rather than staying brief while still giving the real answer. Both prompts now separate
    the two failure modes explicitly: a greeting/small talk still gets a short, natural reply (no
    unsolicited pitch), but a short, specific question (a number, a policy, a fact) always gets the
    complete real answer even if that reply ends up a little longer than the question itself — never
    trading accuracy/completeness for brevity.
  - **`engineBuildProductEnquirySystemPrompt` now starts with `c.main_prompt` too, same as the other
    three reply-generating prompts (`engineBuildFaqSystemPrompt`, `engineBuildObjectionSystemPrompt`,
    `engineBuildFirstTouchIntro`).** It was the one prompt in the engine that left this out entirely —
    a fully self-contained, hardcoded persona with no hook for a client's own tone/closing-style
    instructions, so whatever a client wrote in Main Prompt had zero effect specifically on
    product-enquiry replies. Every hardcoded instruction in this prompt is phrased the same "Default
    X — follow this unless the persona/instructions above specify otherwise" way the other three
    prompts use, so `main_prompt` is authoritative here too now.
  - **Opt-in setting to share the link on enquiry too — `ecom_link_on_enquiry`** (new CLIENTS
    field, Single line text, `'Yes'`/`'No'`, default off — Ecommerce module → Settings → "Order
    Link on Product Questions"). The "never send the link until real order intent" rule above is
    the default, but some clients want the link shared earlier — as soon as a customer asks about
    size/color/stock/price and the answer sounds like a green light to buy. When on, the enquiry
    branch resolves a checkout link (`buildCheckoutLink(c, clientId, product.sku)`) and passes it
    into `engineBuildProductEnquirySystemPrompt` as something the model *may* share if it naturally
    fits the reply — not appended unconditionally to every enquiry reply, since a customer who only
    asked "is this in stock" shouldn't get an unsolicited checkout link. A pending order is only
    logged (`logPendingOrder`) when the link was actually made available that turn, same as the
    `mode:"order"` branch — an enquiry reply with the toggle off shares no link, so there's nothing
    to log yet. The product photo is unaffected by this toggle either way — it always sends
    alongside a confidently-matched product (`imageUrl:product.image_url`), whether or not a link
    was also included that turn.

**`[ORDER_LINK]` — a real substitution placeholder for a client's own scripted wording in Main
Prompt.** Real observed failure: a client wrote their own closing line straight into Main Prompt —
`"Order ചെയ്യാൻ ഇവിടെ ക്ലിക്ക് ചെയ്യൂ: [ORDER_LINK]"` — expecting `[ORDER_LINK]` to become a real
clickable link, the same way `{name}` gets substituted in follow-up messages elsewhere in this
file. Nothing did that substitution, so the model (correctly) echoed the client's own text
verbatim, including the literal, unusable string `[ORDER_LINK]`, straight to the customer.
`engineSubstituteOrderLinkPlaceholder(text, c, clientId, sku)` now runs on every ecommerce reply
right after `engineCallLlm` returns — in the product-enquiry branch (`sku` = the matched product's,
so the link goes straight to that item), and in the general FAQ/objection routes (`sku` = `''`,
so `buildCheckoutLink` falls back to `external_store_link` or the generic order.html catalog page,
since there's no specific product in view there). Case-insensitive, ecommerce-only (`buildCheckoutLink`'s
shape is ecom-specific), and a cheap no-op for any client who never uses the placeholder. Documented
in the Main Prompt field's own hint text (dashboard.html) so a client discovers this without having
to hit the bug first.

**Product resolution now falls back to a fuzzy name match when the sku doesn't exactly match.**
`detectOrderSignal` asks the model to copy a real product's `sku` string verbatim from the catalog
it was given — reliable when the product is unambiguous, but an LLM reproducing an exact
alphanumeric code is inherently less trustworthy than an LLM reproducing a natural-language name.
Observed live: a customer replied bare "Yes" immediately after the bot's own prior message had
named a specific product by name and price — `detectOrderSignal` correctly classified `mode:"order"`
(confirmed by the exact fallback wording that reached the customer), but the `sku` it returned
didn't match any real product, so `ecomFindProductBySku`'s exact lookup failed and the customer got
"which item would you like?" immediately after the bot had just told them. `detectOrderSignal` now
also asks for `product_name` (the plain catalog name) whenever it names a `sku`, or whenever it's
confident which product is meant even without being sure of the exact sku spelling.
`ecomResolveProduct` (replacing direct `ecomFindProductBySku` calls in `handleEngineWebhook`'s
order-check) tries the exact sku match first, then falls back to a case-insensitive substring match
against `product_name` over the same client's catalog — the same content-with-a-fallback pattern
used for the sku-vs-context conflict fix above, applied to a different failure mode of the same
underlying problem (trusting an LLM's exact-string reproduction more than its judgment).

**FAQ answers and flow_json stage progression are now fully decoupled — a `QUESTION` never carries
scripted stage content, ever.** engine.json's original design had a `QUESTION` intent during an
active flow carry both an LLM-generated FAQ answer AND a pending scripted stage message
(`intentData._flowPendingMsg`/`_flowPendingNext`, set whenever the matched flow action had its own
`msg`). Three designs were tried here before landing on removing the mechanism entirely:
1. **Concatenated onto the LLM reply with `'\n\n'`, sent as one message.** Observed live: a direct
   FAQ answer ran straight into an unrelated, differently-toned scripted pitch mid-message, reading
   like two different people had written one bubble.
2. **Sent as its own separate WhatsApp message** (`engineSendFlowPendingMsg`) — fixed the
   glued-bubble problem, but exposed a worse one: nothing gated it against having already been
   sent. As long as the flow stayed on one stage — the normal case whenever a prospect keeps asking
   questions instead of giving a positive/negative reply — it fired again on *every single*
   `QUESTION` turn. Observed live, repeatedly, in the same conversation: the identical canned
   self-introduction pitch sent verbatim after several different questions in a row, alongside
   Chatwoot occasionally auto-reopening the conversation flagging a bot error.
3. **Folded into the same LLM call as a "steer toward this, and skip it if already covered"
   instruction** — better, but still relied on the model's judgment to actually skip it, and still
   coupled two conceptually separate things (answering a question, advancing a sales stage) into
   one reply.
4. **A `QUESTION` (or a stage no longer in `flow_json`, or `NEGATIVE`) always gets a clean FAQ
   answer and nothing else** — this step removed `_flowPendingMsg`/`_flowPendingNext`/`flowNudge`
   entirely and sent scripted stage content only through a dedicated `route==='stage'` branch that
   fired for a genuine flow-relevant reply (`AFFIRMATIVE`, `BOOKING`, etc.), never a question. This
   was itself later superseded by step 5, below — `route==='stage'` no longer exists in the code.
5. **Current design: `flow_json`'s deterministic state-machine dispatch is removed entirely.**
   There is no `stageNode`/`node`/`action`/`stageNotFound`/`wouldRepeat`/`videoUrl` anymore, and no
   route named `'stage'`. Stage progression is now `engineClassifyIntent`'s own judgment call —
   `engineFlowStagesBlock` serializes the client's configured stages (id + message, in order) into
   the *same* classification call that already reports intent/sentiment/language every turn, asking
   for one more field, `next_stage` (validated against the real configured stage ids; falls back to
   the unchanged current stage if the model returns anything else or a client has no stages
   configured). The *content* of a stage message is folded into the FAQ/objection reply as guidance
   the same way (`engineBuildFaqSystemPrompt`/`engineBuildObjectionSystemPrompt` both call
   `engineFlowStagesBlock` too) — "if the conversation is naturally ready for it, work toward the
   current stage's point in your own words... don't repeat something already covered" — rather than
   ever being sent verbatim. Every turn now goes through the FAQ/objection reply generator
   regardless of intent (`AFFIRMATIVE`/`BOOKING`/etc. all fall through to `industryFaqRoute` now,
   the same as a `QUESTION` always did), informed by whatever stage guidance applies; there is no
   separate dispatcher left to fight it for control of the reply. The trade-off, accepted
   deliberately: stage transitions are no longer a guaranteed deterministic lookup, they're a
   judgment call — the same reliability trade-off the rest of this classifier already lives with
   for intent/sentiment/language, and the direct fix for the actual bug (a second, rigid mechanism
   competing with the LLM path), not a new kind of risk introduced.
   - **One place still sends `flow_json` content verbatim, deliberately**: the one-time transition
     from "just finished the `qual_questions` qualification flow" to "now entering stage 1" (inside
     `engineRouteFlow`'s `qualify_next` completion branch). This only fires once per lead — never
     repeated on every turn the way the old per-question dispatch did — so the bug class this whole
     rewrite exists to close doesn't apply to it, and a clean, guaranteed opening line for stage 1
     is a reasonable thing to want verbatim.
   - **The `Stage` field (CRM pipeline reporting) still exists and still means the same thing** — a
     client's Stage Builder UI (Settings → Conversation Stages) is completely unchanged; this was
     purely a backend dispatch-mechanism change, not a data-model or authoring-UI change.
   - **Real cost, not just a trade-off note**: a turn that used to be an instant, free, deterministic
     text send (`AFFIRMATIVE`/`BOOKING`/etc. hitting the old `'stage'` route) now costs an LLM
     reply-generation call (plus, for ecom/travel clients, a catalog-context fetch) every time,
     since everything now funnels through the same FAQ/objection generator.

**Stage messages should stay product/service-agnostic for a client selling more than one thing —
this is an authoring convention, not a code constraint.** A client with multiple products/services
might reasonably worry a single linear stage funnel can't represent them all. It doesn't need to:
stage messages (`flow_json`) and product/service specifics (the ecom/travel context block injected
into the FAQ prompt, `engineBuildEcomContext`/`engineBuildTravelContext`) are two separate systems —
a stage message is pipeline progress ("would you like to see pricing?"), not product content, and a
customer asking about any specific item already gets live, per-item detail from the catalog-aware
FAQ/enquiry path regardless of what stage they're on. The failure mode this avoids: a stage message
that hardcodes one specific product's name reads oddly to a customer who's actually asking about a
different one. `dashboard.html`'s Stage Builder (Settings → Conversation Stages) says this directly
in its own hint text and each stage textarea's placeholder, rather than leaving it to be discovered
the hard way.

**Every reply now follows the customer's own detected language, not a single fixed
`CLIENTS.language` setting.** Before this, every prompt-builder used `c.language||'en'` directly —
one language for every customer of a given client, regardless of what language that particular
customer was actually writing in. Observed live in that same "glued-together paragraph" screenshot:
the FAQ half of the reply was in Malayalam even though the customer's own message was in English —
`c.language` had simply been configured to Malayalam for that client, and every AI reply obeyed it
unconditionally.
- **`engineClassifyIntent`** now also asks for `language` (ISO 639-1, e.g. `"en"`/`"ml"`/`"hi"`) in
  its existing classifier call — one extra field on a call this engine already makes every turn, no
  new request. Returned as `customerLanguage`, `null` if the model didn't return a recognizable
  2-letter code (a very short/ambiguous message, for instance) — callers fall back to
  `CLIENTS.language` themselves in that case, so there's always a sane default.
  `customerLanguage` flows through `engineRouteFlow`'s return value into `routing.customerLanguage`.
- **The classifier's own Gemini/OpenRouter calls used to fail completely silently** (`catch(e){}`,
  no logging at all) — since a failure here means `aiResult` stays `null`, `customerLanguage` falls
  back to `CLIENTS.language` (commonly `'en'`), so a classifier failure was indistinguishable from
  "customer wrote in English": the reply content (a separate, independently-succeeding LLM call)
  could come back correct while the *language* silently reverted to the client's default. Every
  failure branch — unparseable JSON, a non-OK response, a thrown request, or both attempts failing
  outright — now reports via `reportOpsError`.
- **`replyLang` (`handleEngineWebhook`)** = `routing.customerLanguage||c.language||'en'` — computed
  once per turn, passed into `engineBuildFaqSystemPrompt`, `engineBuildObjectionSystemPrompt`, and
  `engineBuildProductEnquirySystemPrompt` (each gained a `replyLang` parameter, still falling back
  to `c.language` internally if ever called without one), so every AI-generated reply now targets
  the actual customer's language instead of the client's fixed default.
- **`engineLocalizeReply`** — the equivalent fix for *static* content: `flow_json` stage messages,
  `qual_questions`, `callback_msg`/`callback_msg_frustrated`, and this engine's own hardcoded
  checkout-link/clarifying-question strings are all text that can't dynamically adapt the way an
  LLM-generated reply can. Translates that text into `replyLang` via a small dedicated LLM call
  (skipped entirely — no-op, no extra call — when `replyLang` is `'en'` or wasn't confidently
  detected, so the common English-conversation case never pays for it), explicitly instructed to
  leave URLs/SKUs/numbers/emoji untouched so a checkout link or product code never gets mangled in
  translation. No caching, same trade-off as every other per-turn LLM call in this engine. Wired
  into the `human`/`qualify`/`qualify_next`/`stage` routes and `engineSendFlowPendingMsg`.
- **`LEADS.Language`** now reflects the detected customer language (`routing.customerLanguage`),
  falling back to `CLIENTS.language` only when detection didn't return one — previously always just
  mirrored the client's fixed setting regardless of what language the customer actually used.
- **Voice follow-ups were a leftover gap in this same principle** — both places that send a Voice
  Follow-up (`cloudflare-worker/worker.js`'s `handleBroadcastFollowupSend`, the manual "Send Next
  Now" button, and `backend/recovery.js`'s `sendVoiceMessage` in the automated recovery/win-back
  ladder — see "Recovery / win-back engine" below) picked their Sarvam TTS language from
  `client.language` only, the same bug this section fixed for AI replies. Both now prefer
  `lead.Language` (falling back to `client.language` only when the lead has never had a language
  detected yet, e.g. an outbound-only lead) — a follow-up now speaks back in whatever language the
  customer was actually last using, not whatever the account happens to be configured for.
- **`mode:"enquiry"` + no confident product match** → falls through to the normal FAQ/flow handling
  untouched (no canned reply, no link) — the context-aware FAQ LLM can respond naturally, e.g. "we
  don't carry that, but here's what we do have."
- **`mode:"order"` + a matched product** → sends `buildCheckoutLink`'s URL (order.html, see below)
  with the reply text and photo, and still calls `logPendingOrder` for a lightweight intent record.
- **`mode:"order"` + no confident product match** → asks a clarifying question ("which item would
  you like?") instead of sending a checkout link to nothing in particular.

**`frontend/order.html` + `POST /ecom/public/order`** — a real checkout form, the built-in
Ecommerce module's counterpart to `book.html`/`POST /appt/public/book` (same three cuts: GET-only
elsewhere, one write path that only ever creates a `pending` row, a fixed customer-safe field
whitelist). Reached via `buildCheckoutLink` (`?client=<id>&sku=<sku>`, always with a specific
product already known — see the 'order' mode case above), it shows that one product's photo/price
and collects size (a dropdown, split from the product's `size` field), name, phone, email, delivery
address and notes, then `handleEcomPublicOrder` writes a full order row: `items` gets the
product+color+size description, `delivery_address` and the new `customer_email` column get the
rest. A client with `external_store_link` set (Shopify etc.) has no in-house checkout page for this
to point at, so `buildCheckoutLink` returns that URL unchanged instead, same as `buildOrderLink`.
- **New required ORDERS-table column: `customer_email`** (Single line text) — add this to both the
  shared default orders table and any client's own, same as every other new column in this file;
  until it exists the write still succeeds (NocoDB silently drops unknown fields rather than
  rejecting the whole row), it just won't have the customer's email captured.
- **A completed checkout produces two order rows, not one** — the bare `logPendingOrder` "intent
  detected" row from the moment the checkout link was sent, and this fuller one from the actual
  form submission. Accepted, not a bug: there's no reliable way from `handleEcomPublicOrder` to know
  whether "the same" customer completing checkout is the same event as the intent row, so no attempt
  is made to reconcile them — staff can tell them apart by `notes` ("Order intent detected — link
  sent automatically" vs. "Placed via the order page").

**Signal auto-send at the bottom of `handleEngineWebhook` is now booking-industry only.** It used
to also branch on `c.industry==='ecommerce'`, re-running `detectOrderSignal` and sending an order
link whenever the primary inline check above hadn't already handled the turn — but now that the
inline check runs unconditionally for every non-human/drop route on every ecom turn, that branch
was redundant (an extra LLM+NocoDB round-trip on every single message) and could re-introduce the
exact "send a link without real order intent" case the paragraph above just eliminated (an enquiry
with no confident product match). Removed; ecommerce clients are fully handled inline now. The
booking-industry branch (healthcare/consultancy/travel/etc, gated on `external_store_link` being
set) is unaffected — it doesn't have this problem since `detectBookingSignal` was never asked to
distinguish enquiry from booking-readiness in the first place.

Historical note on why this branched on `c.industry` at all rather than table-truthiness: that
distinction matters because `ecomResolveTable` falls back to a shared default table id
(`ECOM_DEFAULT_TABLE_IDS`) for *every* client regardless of industry, so table-truthiness alone
can't tell an actual ecom client from a booking-industry one — which is exactly the check
`handleChatwootMessageHook`'s own dispatch (elsewhere in this file, now superseded) relies on, and
appears to make it dispatch every client through the ecom order-signal path in practice, never the
booking-signal one. Worth an independent look if `/hooks/chatwoot-message` keeps running for any
client not yet on this engine — this port doesn't fix that function, only avoids inheriting the
same bug in the new one:
Now only the second half of that dispatch remains at the bottom of `handleEngineWebhook` (the
ecommerce branch moved to the primary inline check, described above): every industry except
ecommerce, once `external_store_link` (Settings → Booking Link) is configured, gets booking-signal
detection (`detectBookingSignal`) against the Appointment module's services catalog, skipping a
lead already at a booking-terminal stage or with a `requested` appointment already pending — the
direct-Cloudflare-auto-send behavior `handleChatwootIncomingBookingSignal` already had, just
running inline here instead of via a second webhook delivery.

**Fidelity to the source workflow, and where this deviates:** `handleEngineWebhook` and its
`engine*` helper functions in `cloudflare-worker/worker.js` are a field-for-field port of
engine.json, reusing this Worker's existing NocoDB/Chatwoot/OpenRouter helpers (same
`CLIENTS_TABLE`/`DEFAULT_LEADS_TABLE` ids the n8n workflow was already reading/writing — both
systems share one NocoDB). Three real behaviors were changed rather than reproduced, because
tracing the source workflow's node wiring showed they were unintended:
- **ConvHistory no longer gets silently capped at ~8 messages.** engine.json's `slim()` helper
  drops the full `history` array (keeping only the trimmed `activeHistory`), but its own
  Prep-lead node reads `sc.history` when rebuilding what gets saved — a field-name mismatch that
  means every saved turn was built from `activeHistory`, not real history, so conversation history
  never actually grew past ~8 messages in NocoDB. Also silently dead-coded the "Warm" score
  fallback that depends on real history length. Both fixed here.
- **The human-handover reply is now what actually gets sent.** In engine.json, the "human" route
  wires straight to a fixed-text HTTP node ("Sure 🙏 connecting you to our advisor now...") — the
  richer message the flow logic computes (a time-aware "we'll call you today/tomorrow at 9am", or
  a Frustrated-specific apology) is calculated but discarded, and the saved ConvHistory disagreed
  with what the customer actually received. Here the computed message is what's sent (falling
  back to the fixed text only when nothing more specific was computed).
- **Voice notes are now really transcribed** (via `GEMINI_API_KEY`, see above) — this one *is* a
  genuine improvement over engine.json, not just a fix: the source workflow never had a
  transcription node wired to its voice branch at all, despite this file's earlier "Media: text,
  image (Gemini vision), voice (download + transcribe)" line describing one. The
  `"(sent a voice note)"` placeholder still exists here too, but only as the fallback when
  `GEMINI_API_KEY` isn't configured or transcription fails for a given note — not the only path.

### Kill switches
Two independent "go silent" levers, both deliberately silent rather than falling back to n8n or
anything else — for an engine suspected of causing harm, "stop replying" is the safer failure mode
than "keep executing possibly-broken logic," and neither n8n nor a Chatwoot-visible fallback is
guaranteed reachable/correct at the moment you'd need one.
- **Global — `ENGINE_ENABLED` (`wrangler.toml [vars]`).** Set to `"false"` to disable
  `/engine/webhook` for every client at once. Config-only, so it needs a `wrangler deploy` to take
  effect — not instant, but a one-line flip is far faster than debugging or reverting real code
  under pressure. Any other value (including leaving it unset) means enabled.
- **Per-client — `engine_disabled`** (new required CLIENTS column, Single line text, `'Yes'`/`'No'`).
  Scopes the same "go silent" behavior to one client — useful when a single client's `flow_json`
  or other data is causing a crash loop or bad behavior, without taking the whole platform down.
  `engineSyncChatwootWebhook` also respects it: while `engine_disabled==='Yes'`, it leaves that
  client's Chatwoot webhooks entirely alone (doesn't register, doesn't clean up), so an admin can
  manually re-add the client's old n8n webhook in Chatwoot without the next Settings-save sync
  immediately deleting it again. Turning `engine_disabled` back to `'No'` and re-triggering a sync
  (any Settings save, or reconnecting WhatsApp) restores the engine, replacing whatever webhook
  was manually added back.
- **What this is not:** neither lever automatically fails a client back onto n8n — there's no code
  path that re-registers a client's old `webhook_url` on its own. Restoring n8n for a specific
  client during an incident is a manual Chatwoot step (re-add the webhook by hand) that only stays
  in place while `engine_disabled==='Yes'` for that client.

### Silence bot after human handover (optional, off by default — bot keeps replying)
engine.json's own Code·State hard-stop — never send another message once a lead is handed over to
a human, so the bot can't talk over a live agent — is **opt-in here, not the default**. By default
the bot keeps replying (ordinary FAQ-style) even after handover, e.g. outside business hours or
while waiting for a rep to actually pick up the conversation; a client who wants the stricter
engine.json behavior (bot goes fully silent the instant a human's involved) turns it on explicitly.
- **`handover_silence_enabled`** (new CLIENTS column, Single line text, `'Yes'`/`'No'`, defaults to
  the bot-keeps-replying behavior when unset) — toggle in dashboard.html Settings → "🤝 Human
  Handover". When `'Yes'`, two things change together (both are required — see their own comments
  for why one alone isn't enough): `handleEngineWebhook` hard-stops on any lead with
  `Handover==='Yes'`/`Stage==='human_handover'`, and `engineRouteFlow`'s matching
  `state.stage==='human_handover'` → `route='drop'` branch also fires. Left `'No'` (or unset),
  neither fires — a handed-over turn falls through to ordinary FAQ-style routing (`human_handover`
  is never a real `flow_json` stage, so it lands in the `stageNotFound` branch) instead of being
  silenced.
- **The lead's own record is unaffected** — `Handover` stays `'Yes'` and `Stage` stays
  `'human_handover'` regardless of this toggle, so the CRM/dashboard still correctly shows the lead
  as escalated; only whether the bot keeps sending replies changes. A staff member can still take
  over the conversation in Chatwoot at any point, same as always.

### Itinerary location photos + "Full Itinerary" send format
The Travel Agency module's itinerary builder (`openItinModal`/`renderItinDays` in
`frontend/dashboard.html`) now supports one photo per day-item, and the itinerary can be sent as
itself (day-by-day, with those photos) rather than only as a converted price quote.
- **Photos**: each item in `ta_itineraries.days` (LongText JSON) can carry an `image` field —
  same base64-data-URL-on-record pattern as `CLIENTS.quote_logo_url`, capped at 250KB per photo
  (tighter than the logo's 500KB since one itinerary can have many items, all landing in the same
  JSON column) via `itinHandleItemImage`. No new NocoDB column — `days` already existed as
  LongText, this just adds a key inside each item object. Older itineraries saved before this
  change simply have no `image` key on their items, which renders as "no photo" everywhere.
- **Full Itinerary send format**: the Agency module's existing bulk "Send Quotation to Leads" tab
  (`renderItinSendQuote`/`sqSend`, originally built to convert a Package or Itinerary into a
  priced quote PDF) gained a fourth `SQ_FORMATS` entry, `itinerary_full`, selectable only when the
  chosen source is an itinerary (`sqFormatPillsHtml` filters it out for packages). Instead of
  `sqBuildLineItems`' priced table, it renders the itinerary's own day/item/photo content via
  `itinBuildFullPdfDoc` — same branding (logo/accent/footer, from the same `quote_*` CLIENTS
  fields) as the priced formats, just no pricing section, and the price/currency/pax/validity
  fields are hidden (`#sqPricingGrid`) since they don't apply. Delivery is the same
  lead-search-and-checkbox-select-then-send-via-Chatwoot flow as the priced formats — same
  `/quote/send` route, same per-lead skip-if-no-linked-chat behavior, same progress log. Sent
  leads get tagged `'Itinerary Sent'` (not `'Quotation Sent'`) and are **not** given
  `QuoteSentAt`/`QuoteSentTotal` (there's no total), so this doesn't show up in the quote-specific
  sent log — only in the lead's `Tags`/`ConvHistory`.
- **Per-itinerary logo**: `ta_itineraries.logo_url` (new LongText column — base64 data URL, same
  pattern as the photos and `CLIENTS.quote_logo_url`) lets one itinerary override the account-wide
  logo on its own PDF only, e.g. a co-branded trip with a partner operator. Set via the "Logo"
  field in the itinerary modal (`itinHandleLogoFile`/`itinRenderLogoWrap`), capped at 400KB. Falls
  back to `CLIENTS.quote_logo_url` when blank — `itinBuildFullPdfDoc` picks whichever is set.
  Auto-created for brand-new Agency-module setups (added to the `itineraries` table schema at
  `frontend/dashboard.html:9060-9065`); existing clients who provisioned `ta_itineraries` before
  this change need the column added by hand in NocoDB.
- **`itin_number_seq`** — see the CLIENTS field table above — is this format's own PDF numbering
  counter (`ITN-0001`, `ITN-0002`, ...), kept separate from `quote_number_seq` for the same reason
  `invoice_number_seq` is separate from it.
- **"Create Itinerary" from Packages / Group Fares / Special Fares**: a 🗺️ button on each of
  those three record types' cards/rows (`pkgCreateItin`/`groupFareCreateItin`/
  `specialFareCreateItin`) opens the itinerary modal pre-filled from that record instead of blank
  — `openItinModal(id, prefill)` gained an optional second argument for this (only used when
  `id` is falsy, so editing an existing itinerary is unaffected). No new NocoDB columns — it maps
  each source's own fields into the same `title`/`destination`/`from_date`/`to_date`/`notes`/`days`
  shape a normal itinerary already has:
  - **Package** → blank days sized to `nights`, `inclusions`/`notes` folded into the itinerary's
    own Notes field. No dates (packages are date-less catalogue items).
  - **Group Fare** → a single "Departure" day with one `flight`-type item pre-filled from
    `airline`/`flight_number`/`departure_time`/`arrival_time`; `departure_date` copied across.
  - **Special Fare** → a "Departure" day, plus a "Return" day if `return_date` is set, each with a
    seeded `flight` item; `from_city`/`to_city`/`departure_date`/`return_date` copied across.
  Saving still creates a genuinely new `ta_itineraries` row via the existing `saveItin()` — this
  only changes what the modal starts with, not how it saves.

### Bot auto-reply toggle (optional, off by default — bot replies normally)
For a client who wants to run their own bot (e.g. a custom n8n workflow wired to the same
Chatwoot inbox) and have it own the WhatsApp replies, without losing this CRM's lead
tracking/analytics on that same conversation. Unlike the `engine_disabled` kill switch above, this
does **not** stop `handleEngineWebhook` from running — classification, `flow_json` routing, the
LEADS upsert (Stage/Score/QualScore/WinProbability/Sentiment/etc.), `ENGINE_ANALYTICS_TABLE`
logging, `last_seen`, and order/booking-signal detection (`logPendingOrder`, `detectOrderSignal`)
all still happen every turn exactly as if the bot were replying. Only the actual outbound WhatsApp
send is skipped.
- **`bot_reply_disabled`** (new CLIENTS column, Single line text, `'Yes'`/`'No'`, defaults to
  replying normally when unset) — toggle in dashboard.html Settings → "🤖 Bot Auto-Reply". Checked
  in exactly two places: `engineDeliverReply` (the single choke point every FAQ/qualify/human/
  selfserve/objection/order/enquiry reply goes through, text or media) returns immediately without
  sending when `'Yes'`; and the auto booking-link nudge in `handleEngineWebhook` (the
  `sendBookingLinkViaChatwoot`/`sendBookingLinkNow` call for non-ecommerce industries) is skipped
  the same way, since sending that link *is* the point of that block — skipping it also means the
  stage-advance bundled inside `sendBookingLinkViaChatwoot` doesn't fire for that nudge, same
  trade-off as the reply itself not going out.
- **Does not touch Chatwoot webhook registration** — `engineSyncChatwootWebhook` still registers
  `/engine/webhook` normally regardless of this flag (it only checks `engine_disabled`), so
  `handleEngineWebhook` keeps receiving every `message_created` event and keeps the CRM in sync;
  it just never talks back. A customer's own bot (n8n or otherwise) still needs its own separate
  webhook registered on the same Chatwoot inbox to actually send replies — this flag only silences
  this app's side, it doesn't wire up anything else.
- **Manual/API-triggered sends are unaffected** — `handleLeadBookingLink` (the `/leads/booking-link`
  n8n-callable route) calls `sendBookingLinkViaChatwoot`/`sendBookingLinkNow` directly, not through
  this flag's gated call site inside `handleEngineWebhook`, so an explicit API-triggered booking
  link still sends even while automatic bot replies are off.

### Idempotency
Chatwoot may redeliver the same `message_created` event (timeout, network retry) — without a
guard, a redelivery arriving after a turn already completed would generate and send a second
reply. `handleEngineWebhook` checks Chatwoot's own message id (`body.id`, read defensively —
unverified against a live payload from this specific Chatwoot version, same honest caveat as
elsewhere this repo parses Chatwoot's shape) against a new LEADS column,
**`LastProcessedMessageId`** (Single line text, new required column), and skips the turn entirely
if they match.
- **If `body.id` is ever absent**, the dedup check is simply skipped (not replaced with a
  content-based guess) — a false-positive duplicate-skip would silently eat a real customer
  message, which is worse than the rare double-reply this check exists to prevent.
- **`LastProcessedMessageId` is claimed early, then re-written at the end of a normal successful
  turn.** Originally this was written only once, at the very end (`engineBuildLeadUpsertBody`,
  alongside `Stage`/`ConvHistory`/etc.) — but that produced an observed real duplicate reply in
  production (the exact same product-lookup message sent twice, ~1 minute apart): a single engine
  turn can run several LLM + NocoDB round-trips deep, easily long enough for Chatwoot's webhook
  delivery to time out and redeliver the same `message_created` event on its own schedule,
  independent of whatever status this handler eventually returns — and the redelivery's own
  idempotency check found nothing to skip yet, because the *first* turn's end-of-turn write hadn't
  happened. `engineClaimMessage` now runs right after the fast synchronous checks (handover/opt-out/
  rate-limit), before `engineResolveUserText`/`engineClassifyIntent`/the reply LLM call — for an
  existing lead it's a one-field `PATCH`; for a brand-new lead it creates a minimal stub LEADS row
  so the final upsert `PATCH`es it instead of creating a second row. This shrinks the redelivery
  race window from "the whole turn" down to "the handful of synchronous checks before the claim" —
  not a true atomic compare-and-swap (NocoDB has no such primitive available here), so it isn't
  airtight, just far smaller than before.
- **A second, D1-backed dedup gate now runs even earlier, before that.** Still observed live even
  with the above in place: Chatwoot's Agent Bot integration logs "Conversation was marked open by
  system due to an error with the agent bot" (its own timeout signal) right before two
  differently-phrased AI replies land back to back — the redelivery's NocoDB state fetch was still
  winning the race against the first delivery's `engineClaimMessage` write often enough to matter,
  since that's several round trips of daylight, not zero. `engine_processed_messages`
  (`migrations/0011_engine_message_dedup.sql`, unique on `client_id, message_id`) is checked via a
  single `INSERT OR IGNORE` immediately after the account-id check — before `engineGetLeadState` or
  any other NocoDB call — so a redelivery is rejected on one fast D1 write instead of racing a
  multi-round-trip NocoDB claim. Doesn't replace `LastProcessedMessageId`/`engineClaimMessage`
  above: not every Chatwoot payload carries an id this table can key on, and the NocoDB claim still
  does its other job of eagerly creating a brand-new lead's stub row. Same fail-open philosophy —
  a D1 write failure here just falls through to the existing checks rather than dropping a real
  customer message.

### Error monitoring
`reportOpsError(env, context, error, extra)` (`worker.js`) is a small, dependency-free alerting
helper — deliberately not a full APM/Sentry integration, since this Worker ships as a single file
with no npm build step (see the file's own top-of-file comment) and a real Sentry SDK needs both.
Two optional, independent destinations (set either, both, or neither — every call site is
best-effort and never throws):
- **`OPS_ALERT_WEBHOOK_URL`** — any URL accepting a JSON `{text:"..."}` POST; a Slack incoming
  webhook works with no adapter needed.
- **`OPS_ALERT_EMAIL`** — requires `RESEND_API_KEY` (already used elsewhere in this file, e.g.
  billing emails) to actually send.

Both are **platform-level, operator-facing** channels for "the system itself is broken" — distinct
from clients' own per-client `slack_webhook_url` field, which `n8n/notifications.json` uses for
business alerts (hot leads, SLA breaches) aimed at *that client's* team, not you.

Wired into two places:
- **The global route dispatcher's catch-all** (`fetch()`'s outer `try/catch`) — reports every
  otherwise-unhandled exception from *any* route, not just the engine, tagged with the method and
  path.
- **`handleEngineWebhook`'s own try/catch**, wrapping the whole turn once the client and payload
  are resolved — reports with `clientId`/`phone` context the generic global handler wouldn't have,
  and returns a clean `{ok:true, skipped:'internal-error'}` (HTTP 200) rather than letting the
  error propagate to the global handler's 500 — avoids a Chatwoot-side retry racing the
  idempotency check above on top of an already-failing turn.
- **`engineSendChatwootReply`** — the one delivery point a customer's reply actually depends on;
  reports on both a thrown fetch *and* a non-OK response (previously not even checked), since a
  silent failure here means the customer gets nothing and nobody would otherwise know.

**Known gap:** most other failures in the engine (an LLM call failing and falling back to a
generic "One moment 🙏" reply, a signal-detection call erroring, an analytics-log write failing)
are still swallowed silently by design — alerting on every best-effort fallback throughout this
file would be noisy without much operational value. The three wiring points above were chosen as
the highest-signal: total silence to a customer, or a fully unhandled crash.

## Instagram DM module (`POST /ig/webhook` — native, no Chatwoot)
Unlike WhatsApp above, Instagram DMs never touch Chatwoot at all: this Worker receives Meta's raw
webhook itself, sends replies straight through the Graph API, and conversations show up in
`dashboard.html`'s existing Chats page (a new "📷 Instagram" switch — same `ConvHistory` shape,
same Leads table). Reuses the engine's classify/route/reply pipeline
(`engineClassifyIntent`/`engineRouteFlow`/`engineCallLlm`) unchanged — confirmed channel-agnostic
— but is deliberately leaner than `handleEngineWebhook`: only the qualify/FAQ/objection/human/drop
routes are implemented. The ecommerce order-link automation, hospitality/category media sends and
booking-signal auto-send that WhatsApp also gets are **not** replicated here — this is a
text-only, core-conversation channel for now, not full parity with every WhatsApp
business-vertical feature.

**Uses "Instagram API with Instagram Login"**, not the Facebook-Login-for-Business/Page-linked
variant — a deliberately separate app credential pair from `META_APP_ID`/`META_APP_SECRET`
(WhatsApp's), authenticating directly against the Instagram professional account with no Facebook
Page involved, and its own OAuth host (`instagram.com`/`graph.instagram.com`, not
`graph.facebook.com`). This means the connect flow is a plain browser-redirect OAuth (same shape
as the Shopify module's connect flow) rather than the Meta JS SDK's `FB.login` popup WhatsApp uses.

**One-time Meta setup:**
1. In [developers.facebook.com](https://developers.facebook.com) → your app (can be the same app
   as WhatsApp's, or a separate one — see the note on that in the PR discussion; nothing about
   this flow depends on which) → **Add use case** → check **"Manage messaging & content on
   Instagram"** → Save.
2. Under that use case → **1. Add required messaging permissions** → **Add all required
   permissions** (`instagram_business_basic`, `instagram_business_manage_messages`,
   `instagram_business_manage_comments`).
3. **2. Generate access tokens** → **Add account** → log in with the Instagram professional
   account you want connected (also adds you as a tester, needed before the app is published).
4. **3. Configure webhooks** → Callback URL: `{WORKER_BASE_URL}/ig/webhook` (this Worker's
   production URL is `https://leadvyne-api-proxy.leadvyne.workers.dev/ig/webhook`) → Verify Token:
   any string you choose. Set that same string as a Worker secret: `wrangler secret put
   META_IG_VERIFY_TOKEN`.
5. Copy that use case's **Instagram app ID** / **Instagram app secret** (shown at the top of its
   setup page — distinct from the main app's own ID/secret) → Worker secrets `META_IG_APP_ID` /
   `META_IG_APP_SECRET`.
6. Nothing else to create by hand — connecting (below) auto-provisions every NocoDB column it
   needs.

**Before submitting for App Review** (only needed once you want *other clients'* Instagram
accounts to connect — any account you've added as a tester works right now without review):
under that use case's **Business login settings**, set:
- **Deauthorize Callback URL**: `{WORKER_BASE_URL}/ig/deauthorize` — `handleInstagramDeauthorize`
  in `worker.js` verifies Meta's signed request and clears that client's `ig_*` fields the moment
  they revoke access from their own Instagram/Meta settings, instead of the stored token just
  silently failing on every send afterward.
- **Data Deletion Request URL**: point this at wherever your actual data-deletion process is
  documented (`privacy.html`'s "Your Rights" section touches on it, but tighten the wording with a
  concrete method — email address, self-serve link — before relying on it for review; this is a
  business decision, not something to leave generic).

**Connect flow:** Settings → Integrations → "📷 Instagram DM" → Connect → `POST /ig/oauth/start`
returns `https://www.instagram.com/oauth/authorize?...` (client id + scope + a signed `state`
carrying the client id, same `signOauthState`/`verifyOauthState` helper Shopify/Google Search
Console use) and the browser navigates there directly (full-page redirect). `GET
/ig/oauth/callback` verifies `state`, exchanges `code` for a short-lived (1h) token via
`api.instagram.com`, swaps that for a long-lived (60-day) token via `graph.instagram.com`, and
stores `ig_id` (the `user_id` Instagram returns — an Instagram-scoped id, not a phone number),
`ig_access_token`, `ig_username`, `ig_connected_at` on the CLIENTS row — auto-created via
NocoDB's Meta API the moment you connect (`ensureClientColumns()` in `worker.js`). The long-lived
token is refreshed daily by `runInstagramTokenRefreshForAllClients` (piggybacked on the existing
2am cron tick) — Meta's tokens expire 60 days after issue if never refreshed, so this has to run
on an ongoing basis, not just at connect time.

**Data model** — Instagram leads live in the *same* Leads table as WhatsApp, not a separate one
(one unified pipeline/dashboard): a new `IgId` column (Instagram has no phone number, only an
IGSID) and a `Channel` column (`whatsapp`/`instagram`, defaults to `whatsapp` for every existing
row). Both auto-created the same way (`ensureLeadsColumns()`), the first time a DM comes in.
`engineGetLeadState`/`engineBuildLeadUpsertBody` both take an optional identity-field parameter
now (`'Phone'` by default — every WhatsApp call site is unaffected) so the same upsert logic works
for either channel.

**Human handover** reuses the exact same `Handover`/`HandoverAt`/`SlaAlerted` fields
`engineBuildLeadUpsertBody` already sets for WhatsApp — the SLA-breach alert
(`n8n/notifications.json`) polls the Leads table generically, not by channel, so an Instagram
handover surfaces there for free. There's no Chatwoot conversation to label
(`engineSendHandoverLabel`), so the Instagram path simply doesn't call it; the lead shows up under
the Chats page's existing "Needs You" filter exactly like a WhatsApp handover does.

**Manual replies** — the Chats page's "📷 Instagram" switch reuses the exact same contact
list/thread UI as WhatsApp (`chatConvoLeads`/`chatSelectLead`, filtered by `Channel`); sending
posts to `POST /instagram/send` (`{lead_id, text}`) instead of `/chat/send`, since there's no
Chatwoot conversation id to send through.

### `InterestedProduct` — brand/category/product interest, detected from the conversation
A new LEADS column (see the LEADS field table near the top of this file) capturing whichever
brand, product, or category a lead has shown interest in, judged straight from the chat rather than
matched against a fixed catalog — same reasoning as the `language` field above: `engineClassifyIntent`
already runs on every inbound message, so this is one more key (`product_interest`) on that same
classifier call rather than a second LLM round-trip. Flows through exactly the same path
`customerLanguage` does: `engineClassifyIntent` → `engineRouteFlow` (forwarded through all three of
its return statements, including the opt-out/resub short-circuits) → `engineBuildLeadUpsertBody`.

Deliberately **not** wired to the Ecommerce module's own `ecom_categories`/product catalog — a
Hospitality client's lead asking about a "2BHK apartment" or a services client's "consultation
package" is just as valid an answer as a specific SKU, so this stays a free-text judgment call that
works identically across every industry, the same trade-off `Sentiment`/`LastObjectionCategory`
already accept for the same reason.

**Only written when non-blank.** Most messages ("yes", "ok", "thanks") have nothing new to add —
`engineBuildLeadUpsertBody` only sets `body.InterestedProduct` when this turn's classification
returned something specific, so a lead's last-known interest survives in between messages instead
of getting clobbered with an empty string on every reply that isn't about a product at all (the
same "sparse signal, never overwrite with blank" treatment `LastObjectionCategory` already gets).

**Leads page — Brand/Product Detected as a first-class filter/table column.** Previously
`InterestedProduct` only surfaced as a signal chip in the lead detail panel
(`renderDetailSignals`). It's now a main element of the Leads list itself, alongside Score/Owner:
a `#leadProductFilter` dropdown in the toolbar (options populated from the distinct
`InterestedProduct` values across `allLeads`, same pattern as `#leadOwnerFilter`), a "Brand/Product"
column in `renderLeadsTable`, a chip on each row in the default `renderLeadsList` view, a saved-view
field (`product`, alongside `owner`/`score`/`mineOnly`), and a column in `exportCsv`.

## Dashboard reorganization (`frontend/dashboard.html`, `frontend/broadcast.html`, `frontend/ecom.html`)
A single information-architecture pass: two new pages, one page promoted out of Settings, two
pairs of pages merged into one, and one standalone page brought inside the dashboard shell instead
of opening as a separate browser tab. All of it is additive/relocation — no existing backend route
or NocoDB table was touched, only what's rendered where and which fields drive it.

### Human Deals page (🤝, new)
Handover leads (`Stage='human_handover'`) previously only existed as rows mixed into the Leads
table/Pipeline kanban — no dedicated view for "what's actually waiting on a human right now."
- **Card grid**, sorted Frustrated-first then longest-waiting by default (also sortable by deal
  value/win %, filterable by owner/sentiment) — `renderHumanDeals()`, `humanDealCard()`.
- **Stats strip**: queue size, SLA breaches (`sla_minutes`), average wait, total `DealValue`
  waiting — `renderHdStats()`.
- **Outcome flow** (`applyHumanDealOutcome()`, shared by every path below) — tags the lead with
  `HandoverOutcome` (see CLIENTS/LEADS field tables above) and clears `Handover`/`HandoverAt`/
  `SlaAlerted` so it drops out of the queue and stale SLA state doesn't linger. `HD_OUTCOME_STAGE`
  maps the outcome to a `Stage`: Won→`won` (reusing the same generic terminal value already
  checked in a few places in this file, e.g. `renderHome`'s conversion counts), Spam→`lost`,
  everything else→`new`/`lost`.
  - **✅ Won** (`markHumanDealWon()`) — one click, no modal. Also best-effort ensures this lead
    exists as a real ERPNext Customer (`POST /erpnext/customers/ensure` →
    `erpnextResolveCustomer`, search-or-create so repeat clicks or a later document sync never
    duplicate it) if the client has ERPNext connected, so a won deal shows up in the Accounting
    module's Customers tab immediately rather than only once/if a document happens to get synced.
  - **🚫 Spam** (`markHumanDealSpam()`) — one click (behind a `confirm()`, since it's the one
    action here that changes future bot behavior). Sets `OptOut='Yes'` — the exact same flag a
    genuine customer-initiated WhatsApp "STOP" sets (`handleEngineWebhook` checks it before
    generating any reply) — so the bot goes silent for this lead going forward, with no separate
    "spam" concept anywhere on the engine side. Excluded from the Team page's Handover Win Rate
    denominator (`renderTeamFunnelStats`) since it was never a real sales conversation.
  - **✕ close icon** (top-right of the card, `openHdRemoveModal()`) — opens a small modal for the
    remaining, less common outcomes: Release back to bot, Lost, No response.
  - **Also reachable from the Leads page** — `markLeadWon()`/`markLeadSpam()` (`dashboard.html`)
    are thin wrappers around the same `applyHumanDealOutcome()` (Won still does the best-effort
    ERPNext customer-ensure; Spam still confirms first) but re-render whichever Leads view is on
    screen instead of `renderHumanDeals()`, so a rep can close out a deal without first navigating
    to Human Deals. Kept as separate functions from `markHumanDealWon()`/`markHumanDealSpam()`
    rather than reusing them directly, since those hard-code a `renderHumanDeals()` refresh. Shown
    in both `renderLeadsList()` (card view, under the name/stage line) and `renderLeadsTable()`
    (table view, new rightmost "Actions" column) — hidden once a lead is already `isWonLead()`,
    `isLostLead()`, or opted out (`OptOut==='Yes'`), since re-clicking Won/Spam on an
    already-closed lead has no useful effect. Buttons stop click propagation so they don't also
    trigger the row/card's own `openDetail()`.
- Nav badge (`dnHdBadge`/`bnHdBadge`) lights up with the current SLA-breach count, computed on
  every Home render (`updateHdBadge()`), not just when the tab is open.
- **🧭 Coach** (`openCoachModal()`/`renderCoachBody()`, `GET /human-deals/coach`) — real-time
  coaching for the rep actually handling a handed-over chat, using signals the engine already
  computes on every inbound message rather than a new AI pass: current `Sentiment`, current
  `LastObjectionCategory` matched against this client's own Settings → Objection Playbook entry
  (approved response shown inline, with a one-click "📤 Send this reply" that posts it straight to
  the chat via the same `/broadcast/send-dm` route Direct Message uses), and a recent timeline of
  both signals so a rep/manager can see where a chat's tone or objections shifted, not just its
  current snapshot. The timeline needed one new piece of storage: `coach_signals`
  (`migrations/0008_coach_signals.sql`, D1) — a per-turn log written from `handleEngineWebhook`
  right after the lead upsert, since the Leads row itself only ever keeps the *latest*
  Sentiment/LastObjectionCategory value, never a history. Same "sidecar data with no other reader"
  reasoning as the Review Request/Referral/Follow-up Engine D1 tables.

### Quotation moved into Human Deals + Invoice mode
The Quotation tab no longer has its own top-level nav entry — `openQuoteFor(leadId, mode)` opens
the same compose page directly from a Human Deals card's "Quote"/"Invoice" button, pre-selecting
that lead (bypassing `quoteEligibleLeads()`'s auto-detected-price-mention gate, which is for the
"browse for a lead to quote" workflow this isn't). `HUMANDEALS_GROUP` makes the Human Deals tab
highlight (not nothing) while on the Quotation page, same pattern `SETTINGS_GROUP` already used for
Billing/Channels/Integrations.
- **Invoice mode** (`_quoteMode`) is the same compose UI/PDF engine (`quoteBuildPdfDoc`,
  `quoteSend`) with different framing — `quoteApplyModeUi()` swaps the page title, send-button
  label, and terms field between `quote_terms`/`invoice_terms`; the PDF header becomes "Invoice",
  drops the "valid for N days" line, and adds a sequential `INV-00NN` number
  (`invoice_number_seq`, only incremented on a real send — `quotePreviewPdf()`'s preview never
  touches it). Separate `Quotation Sent`/`Invoice Sent` tags so a lead can legitimately get both
  (a quote while negotiating, an invoice once they've agreed) without one blocking the other.
- Template/branding settings (logo, terms, validity days) were **not** relocated into Settings as
  originally scoped — they still live on the Quotation compose page itself (now reached only via
  Human Deals), which was the lower-risk option given how tightly the file-upload/logo-preview
  wiring there is coupled to those specific field ids.

### Leads + Pipeline merged into one page, two views
`pagePipeline` (kanban) no longer has its own nav tab — its markup moved inside `pageLeads` as a
second view, toggled by `setLeadsViewMode('list'|'pipeline')` instead of `navigate('pipeline')`.
`_leadsTableView` (the pre-existing List-vs-Table toggle *within* the List view) is unaffected —
this is a separate, outer switch. `goToPipeline()` exists for the couple of buttons elsewhere
(Home quick actions) that used to link straight to the old standalone tab.

### Billing promoted to a top-level nav tab
Previously reached only via Settings' own internal sub-nav (`SETTINGS_GROUP`). No markup moved —
`pageBilling` already existed as its own page div; this was purely a nav-registration change
(`SETTINGS_GROUP` no longer includes `'billing'`, a `dnTab`/`more-item` added, `renderSettingsSubnav`'s
four copies of the sub-nav row had their `Billing` button removed since it'd now be redundant with
the main nav). Nav badge (`updateBillingBadge()`) reuses the same past-due/cancel-at-period-end
conditions `renderHomeBillingBanners()` already computed, rather than a second copy of that logic.

### Knowledge Base page (📚, new)
Structured FAQ entries (`kb_entries`, see CLIENTS field table above) instead of one long pasted
`kb_text` blob — search, category filter, add/edit/delete (`renderKnowledgeBase()`, `kbSubmitEntry()`,
`kbEditEntry()`, `kbDeleteEntry()`). Deliberately **additive to `kb_text`, not a replacement** — the
existing freeform-notes-plus-file-upload Settings section is untouched (moving it risked breaking
its file-upload/drag-drop wiring for no real benefit), and `kb_entries` only ever affects the
processor *payload*: `buildKbProcessorText()` now also serializes entries into a `## KNOWLEDGE BASE
Q&A` block, same additive-only pattern that function already used for policies/social proof/order
links — the stored `kb_text` field a rep sees in Settings is never rewritten.

### Prospects merged into Campaigns (`frontend/broadcast.html`)
Prospects' Google Sheet import (`prospectImportBatch()`, unchanged server-side — still calls the
same `leadvyne-prospects-import` n8n webhook) moved into `broadcast.html` as a new "🎯 Import
Prospects" tab, reusing that page's own `allTemplates` (loaded once by `loadTemplates()`) instead
of a second duplicate template-fetch/create UI dashboard.html's old Prospects page had
(`loadWaTemplates()`/`createWaTemplate()`, now deleted as dead code along with the rest of that
page). `dashboard.html`'s Integrations → Sheets list points its "Prospect Import" row at
`window.open('broadcast.html')` (`INT_SHEETS`' new `external` field) instead of a dead
`navigate('prospects')`.

### Ecommerce embedded as a real nav tab, not a separate browser tab
The existing `window.open('ecom.html?client=...')` industry-conditional nav buttons (desktop +
mobile, `.industry-tab[data-industry="ecommerce"]`) now call `navigate('ecommerce')`, which lazily
points an `<iframe>` (`#ecommerceFrame`, only loaded once — switching tabs away and back doesn't
reset whichever Products/Orders/Shopify/Settings sub-tab the rep was on inside it) at
`ecom.html?client=<id>&embed=1`.
- **Deliberately an iframe, not a ported-in copy of ecom.html's ~1500 lines of markup/CSS/JS.**
  Both files independently define generic class names (`.card`, `.stat`, `.tab`, `.page`) and their
  own `:root` color tokens — concatenating them into one shared stylesheet/script scope risked
  silently overriding `dashboard.html`'s own same-named rules used everywhere else in the app
  (Home, Team, Human Deals, etc. all already use `.card`/`.stat`), a far larger blast radius than
  the Ecommerce tab itself. The iframe keeps `ecom.html`'s own working code 100% untouched and
  isolated.
- **No auth-model change needed.** `ecom.html` was already client_id-based with no session token
  (its `/ecom/*` Worker routes are deliberately no-session, same accepted trust model as the
  automation-facing `/ecom/order-link` etc. routes documented elsewhere in this file) — the iframe
  just passes `clientId` through the URL exactly as `ecom.html` already expected.
- `ecom.html`'s only change: a new `embed=1` param (`isEmbedded`) hides its own header/"Back to
  CRM" button when opened this way, since `dashboard.html`'s own header/nav/notifications already
  surround it — everything else in that file is untouched.

## PWA install prompt (`frontend/dashboard.html`, `manifest.json`, `sw.js`, `icons/`)
There's no App Store/Play Store app — installing the dashboard as a PWA (Add to Home Screen on
mobile, "Install app" on desktop Chrome/Edge) is the only "app icon" experience available, so it's
worth prompting for rather than leaving to chance/discovery.
- **`frontend/sw.js`** already existed before this (registered at `dashboard.html`'s boot, `/sw.js`)
  — cache-first for a short static-asset allowlist (pinned CDN script URLs, `dashboard.html` itself
  for an offline fallback), network-first for navigation, and explicitly never caches NocoDB/API
  calls. What was actually missing for real installability was **`frontend/manifest.json`** (name,
  icons, `display:"standalone"`, theme color) — a service worker alone doesn't make a page
  installable without one. Both need to be deployed at the app's root (same level as
  `dashboard.html`) for their paths (`/sw.js`, `manifest.json`, `icons/...`) to resolve.
- **`frontend/icons/`** — generated from the existing chat-bubble brand mark (the same base64 PNG
  already embedded in `admin.html`'s header), upscaled to `icon-192.png`/`icon-512.png` (transparent
  background, "any" purpose) and composited onto the brand's navy (`#0F2C4C`) background for
  `apple-touch-icon.png` and the `-maskable` variants (logo sized to ~65% of canvas, inside the safe
  zone OS-applied icon masks need) — a maskable icon needs full-bleed background content, unlike the
  transparent "any" ones, or Android can clip it unpredictably.
- **`beforeinstallprompt` capture** (`dashboard.html`) is a top-level statement, not inside the async
  boot IIFE — the event fires once per page load and is lost forever if no listener is attached
  before it does, so it can't wait on anything.
- **Only triggered right after a fresh signup/login** — `maybeShowInstallBanner()` is called from
  `completeLoginResult` (the one function every signup/login path converges on: direct OIDC
  callback, the popup-relayed flow, and auto-provisioning a brand-new signup), never from
  `resumeSession` (an ordinary page reload/tab reopen with an existing session) — so a returning
  user isn't renagged on every visit, only actual sign-in moments.
- **Custom banner, not the raw browser dialog** — `showInstallBanner()` is a small dismissible
  bottom bar, on-brand instead of Chrome's own generic install popup. "Not now" sets
  `localStorage.lv_install_dismissed='1'`, permanently skipping the banner on this device/browser
  after that (there's no "ask me later" tier — a dismiss is a dismiss).
- **iOS Safari has no programmatic install API at all** (no `beforeinstallprompt` equivalent) — the
  banner falls back to a manual instruction ("tap Share, then Add to Home Screen") instead of an
  Install button, detected by user-agent (`pwaIsIOS()`) rather than feature-testing, since there's
  no feature to test for.
- **Already-installed/running standalone is detected and skipped** — `pwaIsStandalone()` checks
  `matchMedia('(display-mode: standalone)')` (desktop/Android) and `navigator.standalone` (iOS)
  before ever showing the banner.
- **Known gap, not addressed here:** session state (`sessionStorage`) doesn't carry over into a
  freshly-launched standalone PWA window — a new top-level browsing context gets its own empty
  `sessionStorage`, so a user who installs the app will likely see the login gate again the first
  time they open it from the home screen/desktop icon, rather than landing straight in. Fixing that
  would mean moving session persistence to `localStorage` (survives across browsing contexts), which
  is a separate change with its own security tradeoff (a session token that outlives the tab, until
  explicit logout, instead of clearing when the tab closes) — not made as part of this.

### Self-service "update available" prompt
A client can leave the dashboard tab open for hours/days — the service worker picking up a new
`sw.js` (browsers detect the byte-diff on their own) never reloads whatever HTML/JS is already
sitting in that tab's memory, so without this a deployed fix silently never reaches an
already-open tab until the user happens to hit refresh on their own.
- `sw.js`'s `install` handler already called `self.skipWaiting()` and `activate` already called
  `self.clients.claim()` before this — a new worker takes over quickly, it just doesn't reload the
  page that's already loaded.
- `initSwUpdatePrompt(registration)` (`dashboard.html`, wired right after `serviceWorker.register()`
  in the boot IIFE) listens for `registration`'s `updatefound` event; when the newly-installing
  worker reaches `state==='installed'` **and** `navigator.serviceWorker.controller` is already set
  (i.e. this page was already being served by a previous worker — a real update, not the very
  first install ever, which has nothing to prompt about), `showUpdateBanner()` fires.
- Also calls `registration.update()` on `visibilitychange` (tab regaining focus) — the browser's
  own background check can be lazy (up to ~24h by spec), so this shortens the gap for a client who
  left a tab open and comes back to it.
- `showUpdateBanner()` mirrors `showInstallBanner()`'s exact visual pattern (small dismissible
  on-brand bottom bar, not the raw browser dialog or a jarring auto-reload) — "Refresh" just calls
  `location.reload()` (the new worker + new `dashboard.html` are already in place by then); "Later"
  dismisses for the current page load only, deliberately **not** a permanent
  `localStorage`-backed dismiss like the install banner's, since a client silently running stale
  code for days is a worse outcome than being asked again next time.
- `CACHE` in `sw.js` is now version-suffixed (`lv-v2`, was `lv-v1`) — bump it on any future deploy
  that changes the cached-asset list, so `activate`'s existing cleanup (`caches.keys()` → delete
  anything not matching the current `CACHE` name) actually has a new name to diff against instead
  of silently keeping the same cache alive forever.

## Leads page rebuild (`frontend/dashboard.html`) — needs-action default, saved views, bulk actions, reactivation

The Leads page defaulted to a flat, unfiltered list and every day-to-day action (stage move, tag,
send template, re-open a cold lead) needed the detail drawer or a trip to another page. Rebuilt
around "what does a rep need to do right now," reusing every backend route already built earlier
this session — **no new Worker routes needed**; only one new CLIENTS config-blob field.

### 1. "Needs Action Today" is the default view, not a flat list
`leadNeedsActionScore(lead)` ranks: won/lost/opted-out leads always score `-1` (never "need
action" again) → an overdue `ReminderDate` scores highest (+1000) → a `HotMoment` signal (+500) →
`Score==='Hot'` (+300) → a conversation stale >48h with no Follow-up-1 sent (+200) → a gentle
staleness tiebreaker underneath all of that. `applyLeadsViewFilter`/`sortLeadsForView` apply this
as the `needs_action` view's filter+sort; opening the Leads page lands here by default
(`_leadsActiveView='needs_action'`) instead of "All Leads." Deliberately computed client-side from
fields already on `allLeads` — no new stored field, no dependency on the separate
`computeAllTasks()` virtual-task engine.

### 2. Saved views (`lead_saved_views` — new CLIENTS field, config-blob pattern)
A rep can save the current filter combo (stage chips, tag, owner, "Mine only", score) as a named
tab via "＋ Save current filters" → `promptSaveLeadsView()`. Stored the same way every other
lightweight structured feature this session stores (`manual_tasks`, `automation_flows`,
`calendar_events`): a JSON array in a new CLIENTS Long-Text column, read/written through the
existing generic `patchClient()` helper (PATCH + verifying re-GET with retry) — **add this column
manually in NocoDB** (Long Text) the same way the other config-blob fields were added.
`getLeadSavedViews()`/`saveLeadSavedViewsList()` read/write it; `renderLeadsViewTabs()` renders
saved views alongside the built-in Needs Action / All Leads / Reconnect tabs, each with an inline
✕ to delete (`deleteLeadsSavedView()`).

### 3. Bulk actions from the list itself
A checkbox on each row (`toggleBulkSelect`) populates `_bulkSelectedLeadIds`; `renderBulkBar()`
shows a bulk-action bar (stage move, tag, assign, Send Template) the moment anything is selected.
`bulkMoveStage()`/`bulkAddTag()`/`bulkAssign()` just loop the selection through the same
`ncPatch(.../LEADS_TABLE_ID/records, ...)` calls a single-lead edit already used — a stage move
also calls `reportLeadQualityChange(id, before, {Stage})` per lead, so the Advanced Pipeline
follow-up cadence resets exactly as it would for a manual one-at-a-time Stage change. No batch
Worker endpoint was added; this is N sequential existing-route calls, acceptable since bulk actions
are an infrequent, human-initiated, small-N operation (not a hot path).

### 4. Fuller one-click action bar per row
Extends the existing Won/Spam buttons with ⏰ Snooze (existing `snoozeReminderLead`), 📅 Follow-up
(new `openFollowupForLead(leadId)` — looks the lead up by Id and calls the existing
`openTaskModal(null, lead)`, matching every other row button's ID-based-lookup convention rather
than embedding a JSON-stringified lead object in the `onclick` attribute), and 📣 Send (opens the
new Send Template modal, see below) — so most day-to-day handling never needs the detail drawer.

### 5. Send Template modal (`#modalSendTemplate`) — reuses existing template infra, dual send path
`openSendTemplateModal(leadIds)` (called with one lead from a row's 📣 button, or the whole bulk
selection from the bulk bar) reuses the Calendar Events feature's already-loaded
`_ceTemplates`/`loadCalendarEventTemplates()`/`ceTemplateBody()`/`ceTemplateVarCount()` (same
`GET/POST /broadcast/templates(/sync)` source, no new fetch path) and mirrors Template Broadcast's
send loop (`sendTemplateBroadcast()` in `broadcast.html`) exactly, including its cold-lead
fallback: if a lead has a Chatwoot `ConversationID`, send via `POST /broadcast/send-template`
(flat `processed_params` map); if not but `clientRecord.wa_phone_id` is set, send directly through
Meta's own API via `POST /wa/send-template` (`components/parameters` shape) instead of silently
failing — same dual path documented under "Template Broadcast: cold-lead fallback." Per-recipient
progress bar + scrolling log box (`.progress-bar-bg`/`.log-box`, new CSS) mirror Template
Broadcast's own send UI.

### 6. Reconnect / Reactivation
"♻️ Reconnect" is a filtered view (`isReactivationCandidate(l)`: `Stage==='lost'` OR tagged
`cold` — the same tag the Advanced Pipeline cadence cron already writes after two unanswered
follow-ups — and not opted out) with a one-click "♻️ Reactivate" per row. `reactivateLead(leadId)`
re-enters the lead at Stage 2 of the configured flow (or Stage 1, or `new` — same
"Released"-outcome stage-picking logic Human Deals already uses), clears the `cold` tag, sets
`OptOut:'No'`, and — unlike the pre-existing detail-drawer "🔄 Re-open" button
(`reopenLead()`, which patches `Stage` directly and does **not** reset the follow-up cadence, a
pre-existing gap left as-is for now) — routes the Stage change through
`reportLeadQualityChange()`, so the Pipeline follow-up cadence resets and a Day-1 follow-up is
queued automatically, exactly as any other Stage change already does. Optionally offers to open
the Send Template modal right after, for a quick win-back message.

### Momentum strip + positive-toned empty states
`renderLeadsMomentumStrip()` shows "🎉 N won this week / 🔥 N hot right now / 💪 N ready for you
today" (or "✨ You're all caught up" when the Needs Action queue is empty) above the list —
reuses the same `isWonLead`/7-day-window convention Home/Team already use. Empty states on every
view are worded positively ("✨ You're all caught up — nothing needs action right now. Nice work!",
"🌱 No dormant leads to reconnect with right now.") instead of a bare "no results."
- **"N hot right now" is clickable**, not just a stat — `jumpToHotLead()` opens the single hottest
  Hot-scored lead's detail directly (the one lead itself when there's exactly one, otherwise
  whichever Hot lead ranks highest by `leadNeedsActionScore`), instead of making a rep filter for
  it manually. `.momentum-link` (new CSS) is the shared underline-on-hover treatment.

### Contact-attempt counter ("2nd no-answer" / "3rd no-answer")
Reuses the three existing `Follow up 1`/`Follow up 2`/`Follow up 3` Yes/No fields already on the
Leads table (previously read-only guards, never written to — see the Advanced Pipeline cadence
section) as three attempt slots instead of adding a new column: `leadAttemptCount(l)` counts how
many are `'Yes'`; `leadAttemptBadge(l)` renders a "📵 2nd no-answer"/"📵 3rd no-answer" chip on the
row once count is ≥2 (nothing shown for 0-1 — a first attempt isn't "going cold" yet).
- **`bumpLeadAttempt(leadId)`** flips the next unflipped slot to `'Yes'` (`ncPatch` + local
  `allLeads` update), capping silently at 3 — there's no 4th slot, matching this field's existing
  3-slot schema. **Auto-called on every actual outreach action** (per the request "if template or
  follow up send, change attempt count automatically"), not on a timer:
  - `sendLeadsTemplate()` — after each successful send, both the Chatwoot and Meta-direct paths.
  - `saveTaskFromModal()` — when a **new** task with `category==='Follow-up'` is linked to a lead
    (covers the row's 📅 Follow-up button, "Push to Task" from the detail drawer, and creating a
    Follow-up-categorized task directly in Task Manager — all count as a real contact attempt).
    `openTaskModal()` now defaults a lead-linked new task's category to `'Follow-up'` so this fires
    from the Leads-page entry point without the rep having to pick a category manually.
  - `reactivateLead()` resets all three back to `'No'` (a reactivation is a genuine fresh start,
    same reasoning as `reopenLead()`'s existing reset).
- **Feeds into "Needs Action" priority, not a separate idle timer**: `leadNeedsActionScore` adds
  `leadAttemptCount(l)*150` on top of its existing overdue-reminder/Hot/staleness weights, so a
  lead with more unanswered attempts keeps outranking a fresher one — combined with the score's
  pre-existing staleness tiebreaker (`hrsSince`), a lead that's simply been sitting idle a long
  time still drifts to the top over time even before any attempt is logged against it, satisfying
  "auto-bump to the top after a set idle time" without needing the counter itself to move on a
  timer (it only moves on a real send, so it stays an honest count of actual attempts).

### One-tap Call button (Callback / No Answer leads)
`leadNeedsCallback(l)` flags a lead as waiting on a callback if either: its Tags include something
matching `/callback|no answer/i` (several industry tag presets already have literal `Callback`/`No
Answer` tags), or its most recent logged call (`CallLog`, `saveCall()`'s own `unshift` — index 0 is
newest) has outcome `No Answer` or `Callback Requested` (`modalCall`'s existing outcome options).
When true, a 📞 Call button (`tel:` link via `callHrefFor(l)`) appears directly in the row's action
bar (list view) / actions cell (table view, icon-only), alongside Won/Spam — one tap dials without
opening the detail drawer first.

### Persistent detail panel (docked, Leads page only, desktop/tablet only)
Clicking a lead on the Leads page opens the detail panel docked to the right side
(`.modal.docked` — `position:fixed;top:0;right:0;bottom:0;width:420px`, new CSS) instead of the
usual centered/dimmed modal, so a rep can keep working down a filtered list without losing their
place. `openLeadDetailModal()` (called from `openDetail()` in place of a bare `openModal()`) adds
`.docked`+`.open` directly and **skips the dimming overlay** when `_leadsDocked` is true, so the
rest of the list stays visible/clickable; `navigate(page)` sets `_leadsDocked=(page==='leads')`
and removes `.docked`/`.open` when navigating away from Leads while the panel is open. Scoped
narrowly on purpose: every other one of the ~30 existing `.modal` call sites in the app (and
`openModal()`/`closeModal()` themselves) are completely untouched — this only changes what happens
specifically while the Leads page is active.
- **Gated to `window.innerWidth>=768` (this file's existing desktop breakpoint) in
  `openLeadDetailModal()` itself**, checked fresh on every open. A phone screen has no room to show
  a 420px side panel *alongside* a list anyway, so below that width the detail view falls back to
  the normal full-screen bottom-sheet modal (with its overlay) — the same proven behavior every
  other modal in the app already uses, avoiding mobile-only edge cases entirely rather than trying
  to make "docked" work on a screen too narrow for it to mean anything.
- **Fixed bug: closing (and, by extension, adding notes/follow-ups) didn't work on mobile before
  this gate existed.** The original `.modal.docked` rule set `transform:none!important`
  unconditionally (i.e. even without `.open`) to cancel the base mobile bottom-sheet's
  `transform:translateY(100%)` hide mechanism while docked-and-open. But on mobile that's the
  *only* way `.modal` ever hides — desktop instead hides via `opacity:0;pointer-events:none` (see
  the `@media(min-width:768px)` rule), which `.docked` never touched. So once a lead was opened in
  docked mode on a narrow screen, `closeModal()` removing just `.open` (the `.docked` class itself
  is only cleared by `navigate()` on leaving the Leads page) had no visual effect at all — the panel
  stayed fully rendered and interactive on top of everything, silently swallowing every subsequent
  tap (including the ✕ button, and any note/follow-up UI the rep tried to reach next). Fixed by
  making `.modal.docked`'s own hidden state a real off-screen `transform:translateX(100%)!important`
  (mirroring the base mobile bottom-sheet's approach) and `.modal.docked.open` the visible
  `translateX(0)!important` — belt-and-suspenders alongside the `>=768px` gate above, so the docked
  CSS is correct on its own even if that gate is ever bypassed.

## Leads page: AI Data Analyst & Business Intelligence (`frontend/dashboard.html`)

A third Leads-page view mode (`🧠 AI Analyst`, alongside the existing List and Pipeline switch —
`setLeadsViewMode('analyst')`, `#leadsAnalystView`) for cross-lead pattern-finding, distinct from
both the per-lead AI signals already on the Leads page (Deal Health, Next-Best-Action, Win %) and
the stats-focused Reports page (Sales/Marketing/WhatsApp/Ecommerce/Product/SEO). Same sub-nav/
lazy-load convention as Recruit/Appointments/Hospitality/Reports: `renderAiAnalyst()` →
`renderAiSubPage(page)`, a `.hosp-tab`/`data-ai` sub-nav, one shared `#aiContent` container.

**Everything is computed instantly, client-side, from `allLeads` already loaded — zero new Worker
routes, and deliberately no LLM calls.** Every "insight" is real arithmetic (contribution
decomposition, linear trend regression, revenue-at-risk ranking) with a templated plain-language
sentence filling in the actual numbers, not a black-box generated narrative — free, instant, and
fully explainable. The one new piece of storage is `bi_saved_analyses`, a JSON array on a new
CLIENTS field (Long Text — **add this column manually in NocoDB**, same convention as every other
config-blob field this app uses) for the Custom Analysis builder's saved views.

### Shared engine — dimensions, metrics, pivot, contribution decomposition
- **`AI_DIMENSIONS`** (Stage, Score, Source, Country, Owner, Tag, Language, Month created) and
  **`AI_METRICS`** (Lead Count, Win Rate %, Avg Deal Value, Total Won Value, Avg Win Probability) —
  one registry each, read by all three interactive tabs below so "what can we slice/measure" stays
  consistent everywhere.
- **`aiEstimateWinProb(l)`** — falls back to a Score-based estimate (Hot 70% / Warm 40% / Cold 15%)
  when a lead has no manually-set `WinProbability`, so a weighted pipeline total doesn't silently
  treat most of the pipeline as 0%. Only used inside this module — the existing Team/Reports pages'
  own weighted-forecast calculations are untouched.
- **`aiPivot(leads, dimKey, metricKey)`** — groups leads by a dimension, computes a metric per
  group, sorted descending. The one function both Custom Analysis and Overview's auto-picked
  breakdowns run on top of.
- **`aiContribution(leadsBefore, leadsAfter, metricKey)`** — real contribution decomposition, not a
  guess. For an *additive* metric (count, total value) a segment's contribution to the overall
  change is exactly its own before/after difference — these sum back to the total delta exactly.
  For a rate/average metric, exact decomposition needs calculus a plain sum can't give, so this
  uses the standard approximation instead: weight the segment's own change by its share of volume
  in the "after" period — good enough to rank "which segment moved the needle most."
  - **Uses `AI_RCA_DIMENSIONS` (all of `AI_DIMENSIONS` except Month created)**, not the full list —
    comparing two date-bounded windows against each other means "Month created" would trivially
    "explain" most of any count-based delta (the windows are themselves defined by date range, so
    of course the more recent month has more of the recent leads) — circular reasoning dressed up
    as an insight. Caught by an early test expecting a specific segment to top the ranking and
    getting "Month created" instead; Month is still a fully valid dimension for the Custom Analysis
    builder, where "count by month over all history" is a genuine trend view rather than a
    before/after comparison.

### 🔍 Root Cause (`renderAiRootCause`/`runAiRootCause`) — Automated Root Cause Analysis
Pick a metric and two comparison windows (defaults: last 30 days vs. the 30 days before that), hit
Analyze — every dimension's segments are ranked by `aiContribution`'s impact, each rendered as a
templated sentence (`aiContributionSentence`): "**Instagram** (Source) increased from 1 to 2 — the
largest single driver of the overall change (1→2 leads)."

### 📈 Forecast (`renderAiForecast`/`aiForecastCompute`) — Predictive Forecasting (pipeline revenue)
Two numbers shown side by side rather than blended, so a rep can sanity-check one against the
other:
- **Weighted Forecast** — bottom-up: every open, non-opted-out deal's `DealValue × aiEstimateWinProb`,
  summed. Extends the existing Revenue Forecast pattern (Team/Reports pages) rather than replacing
  it — same `DealValue × WinProbability/100` shape, just with the Score-based fallback added.
- **6-month trend + 3-month projection** — actual Won revenue per month (`closedMonthKey`, reused
  from the existing Revenue Forecast code), plus a simple linear regression over those 6 points
  projected 3 months forward (dashed/striped bars, needs at least 2 non-zero months to render at
  all). Explicitly labeled a "straight-line estimate, not a guarantee" — this is a transparent trend
  line, not a real predictive model.

### 💔 Churn & LTV (`renderAiChurn`/`aiChurnCompute`) — Customer Churn & LTV Scoring
Groups leads by phone number (the one identifier consistent across separate lead records for the
same person/business — there's no dedicated "customer" entity) rather than inventing a new one.
- **Broad churn definition**: any relationship gone quiet with no currently-active deal anywhere,
  whether it ever converted or not (a never-converted lead going cold is already covered
  operationally by the Reconnect view — SETUP.md "Leads page rebuild"; this is the revenue-risk
  lens on the same underlying signal, not a duplicate feature). "Idle" means no active/non-opted-out
  deal for that phone number and no message/activity in 30+ days.
- **LTV** = sum of `DealValue` across all Won leads for that phone number. Deliberately scoped to
  Leads' own recorded deal value across all engagements from that phone — does **not** fold in
  Ecommerce order history (a separate table this module doesn't reach into); a known V1 scope limit,
  not an oversight.
- **Ranked by revenue-at-risk** (`ltv * min(daysIdle/90, 3)` when LTV>0, else just `daysIdle`) so a
  contact who actually paid before outranks a much larger pile of never-converted cold leads, while
  still surfacing everyone per the broad definition above — a real customer gone quiet for 100 days
  ranks far above a lead that never converted and has been idle 200 days.
- Each row has a one-click **📣 Win back** button (`openSendTemplateModal`), reusing the Send
  Template modal built for the Leads page rebuild rather than a new send path.

### 🛠️ Custom Analysis (`renderAiCustom`/`runAiCustom`) — Custom Buildable Analysis
A pivot-style builder: pick a metric, group by any dimension, optionally filter by stage/tag, Run
— renders as a bar-row list (`aiPivot`, same engine as the auto-generated breakdowns). **Save**
(`saveAiCustom`) prompts for a name and appends `{id, name, metric, dim, stage, tag}` to
`bi_saved_analyses` (`patchClient`, exact same config-blob pattern as the Leads page's own saved
views, `lead_saved_views`); saved analyses render as `⭐`-prefixed chips with an inline ✕ to delete,
click to reload the exact same configuration and re-run it.

### 🧭 Overview (`renderAiOverview`) — Auto-Generating Dashboards
Reuses the exact same `aiContribution` engine as Root Cause, just run automatically for the two
headline KPIs (lead count, win rate) over a fixed last-30-vs-prior-30-days window, plus the
Forecast and Churn headlines — four cards, each clickable straight through to its own full tab.
Not a separate "auto-dashboard" engine; deliberately reuses the same math as everything else in
this module so there's only one contribution-analysis implementation to reason about.
- **Lead-Scoring Calibration card** — `aiPivot(resolvedLeads, 'score', 'winrate')`, i.e. the actual
  win rate for each Score tier among resolved (won/lost) deals. If "Hot" isn't converting
  meaningfully better than "Warm," that's a sign the Hot/Warm/Cold heuristic itself needs
  recalibrating, not that individual leads are mis-scored — a self-check most CRMs never surface.
- **"📧 Email me this snapshot" button** (`emailAiOverviewSnapshot()`) — sends the current Overview
  numbers to the logged-in user's own email (`myEmail`), reusing the existing `/tasks/notify` email
  route (already wired for task-assignment emails) rather than a new send path. Deliberately a
  manual "send now" action, not a scheduled digest — a genuinely automatic weekly email would need
  new cron/scheduling infrastructure plus a configured recipient, left as a natural next step.

### 🔍 Root Cause — `objection` dimension
`AI_DIMENSIONS` now also includes `objection` (`LastObjectionCategory`), so Root Cause and Custom
Analysis can both explain a change through "which objection" too, not just stage/score/source/etc —
no extra work, it's just another entry in the same registry.

### ⚠️ Objections (`renderAiObjections`) — why deals are lost, aggregated + trended
The Team page already shows a raw objection snapshot (leads *currently* sitting on each category)
and a 4-week sentiment trend; this tab adds the comparison lens neither of those covers: among
**lost** leads specifically, which objection category is up or down this month vs. last
(`aiPivot(lostLeads, 'objection', 'count')` run over two 30-day windows, categories ranked by
`|delta|`) — "Price objections are up from 3rd to 1st this month" is a different, more actionable
finding than a snapshot count, since it points at *what to fix in the pitch*, not just which segment
underperformed. Same caveat as the Team page's own objection breakdown: only the most recent
objection per lead is tracked, not a full history.

### 👥 Rep Performance (`renderAiReps`) — rep × source matrix + best time to contact
Two "how/when should reps work leads" views grouped into one tab rather than two thin ones:
- **Rep × Source win-rate matrix** — a real cross-tab (rows = `Owner`, columns = top 8 `Source`
  values by presence, capped so the table doesn't sprawl), each cell = win rate (count) for that
  rep's leads from that source. Turns into a concrete routing rule: send a given source's leads to
  whichever rep already converts it best.
- **Best time to contact** — buckets `LastMsgAt` (falls back to `Date`) by hour-of-day and
  day-of-week, shown as two bar lists with the busiest hours called out. Reflects overall message
  activity, not a confirmed "reply" moment specifically — a reasonable proxy for when leads are
  actually engaging, not a precise instrumented measurement.

### 🚧 Bottlenecks (`renderAiBottlenecks`) — stage dwell time + Speed to Lead
Two "where does the process itself lose time" lenses:
- **Stage Bottlenecks** — `GET /ai/stage-durations` (new Worker route, session-gated) reads the
  Advanced Pipeline follow-up cadence's own D1 table (`pipeline_followups`,
  `migrations/0013_pipeline_followups.sql`, `stage_entered_at` reset on every real Stage change) —
  reused rather than adding new instrumentation, since it already tracks exactly what's needed.
  Groups by `stage`, averages `now - stage_entered_at` for leads currently sitting in each stage.
  **This is a snapshot** ("12 leads have been stuck in Qualified for an average of 9 days right
  now"), not a historical "average time to pass through stage X" — the table overwrites
  stage/stage_entered_at on every transition, so no stage-transition history exists to compute that
  from. Returns `{enabled:false}` when the client has no rows yet (Advanced Pipeline cadence never
  enabled, or no leads have changed stage since).
- **Speed to Lead** — bucket `HandoverResponseMinutes` (new field, see below) against whether the
  handover actually converted (`HandoverOutcome==='Resolved-Won'`, Spam excluded from both counts
  and rate — same convention as the Team page's own handover-conversion stat). Answers "does a
  faster human response actually correlate with winning more handovers" with real data, not a
  guess.
  - **New field: `HandoverResponseMinutes`** (numeric, **add manually in NocoDB**) — captured in
    `applyHumanDealOutcome()` (`frontend/dashboard.html`) at the exact moment a handover resolves,
    computed as `now - HandoverAt` in minutes, *before* the same patch clears `HandoverAt` back to
    blank. This is the only place that elapsed wait is ever recoverable — once `HandoverAt` is
    wiped on resolution, it's gone, so capturing it anywhere later isn't possible. A lead that was
    never actually waiting on a human (blank `HandoverAt`) leaves this field untouched rather than
    writing a bogus 0.
  - **Why not measure bot-reply speed instead**: the bot replies in near-real-time to virtually
    every message, so "time from lead creation to first bot reply" would be a nearly-constant,
    uninformative number. The variable, business-relevant "speed to lead" in this app is
    specifically how fast a *human* picks up an escalated handover — which is exactly what
    `HandoverResponseMinutes` measures.

### 📢 Marketing Efficiency (`renderAiMarketing`) — ad spend vs. realized Won revenue
Reuses the existing Meta Ads spend-trend route (`GET /meta/ads/spend-trend`, already built for the
Meta Ads ROI report) compared against actual Won deal value closed that month (`closedMonthKey`,
reused from Forecast) — a monthly ROAS-style trend. Deliberately **not** "spend by campaign" as
originally floated: Meta's Ads Insights call here is `level=account` (see `handleMetaAdsSpendTrend`'s
own comment on why — Conversions API and Marketing/Insights API are two separate Meta APIs, and
this integration never fetches at campaign granularity), so per-campaign attribution isn't
available without a materially bigger rework of that integration. What this *does* catch that the
existing Meta ROI report (spend vs. lead *count*) doesn't: "this account brings cheap leads that
rarely close" — a different and often more painful finding than cost-per-lead alone. Degrades to an
empty-state prompt if Meta Ads isn't connected with `ads_read`. Assumes deal values and ad spend
share one currency — no conversion is applied.

### 💔 Churn & LTV — repeat-customer addendum (ecommerce only)
`GET /ai/repeat-customers` (new Worker route, session-gated, ecommerce industry only) reads the
client's own Orders table directly (same `ecomResolveTable`/`ncFetch` pattern
`handleShopifyAnalytics` already uses), grouped by `customer_phone`, returning customers with **2+
orders** sorted by total spend. This fills the specific gap the Leads-only LTV above explicitly
doesn't cover: a customer can place several Orders without ever creating a second Lead record, so
grouping Leads by phone (what the base Churn & LTV view does) misses real repeat-purchase history
entirely for ecommerce clients. Rendered as a supplementary card beneath the main Churn & LTV table
— genuine order-based LTV, not a proxy.

## Marketing Studio module (`frontend/marketing-studio.html`, `feat_marketing_studio_enabled`)
A standalone short-form video repurposing tool — upload a long video, auto-transcribe it, edit
captions, pick a caption style, render a vertical/square/landscape clip, send it out. Deliberately
a **different kind of "marketing" module** from Campaigns/Email Marketing (`broadcast.html`/
`email-marketing.html`), which send messages — this produces a video asset — so it gets its own
standalone page and its own Cloudflare D1 tables, not a NocoDB table or a dashboard.html tab.

### Gating — defaults OFF, unlike most other feature toggles
Controlled by a Clients field, `feat_marketing_studio_enabled` (`Yes`/`No`), toggled from
Settings → 🧩 Modules → **Industry Modules** card (not the Dashboard Tabs card — see the comment
above that markup in `dashboard.html`). Every other `feat_*_enabled` flag in this app
(`feat_campaigns_enabled` etc., via `setupFeatureTabToggle`) defaults to **enabled** — "anything
other than `'No'` counts as on" — so a brand-new toggle doesn't accidentally hide something a
client already relies on. This one is the opposite: only the literal value `'Yes'` counts as
enabled, so it stays off for every existing client until someone deliberately turns it on. Two
reasons: it's metered (see Usage below — a client shouldn't suddenly start burning transcription
minutes it never asked for) and it does nothing useful until an operator has actually configured
the external render pipeline (see "The render pipeline contract" below). Like every other `feat_*`
flag here, the gate is frontend-only — `/marketing/*` Worker routes don't re-check it themselves,
same as `/email/*`, `/accounting/*`, etc.

### What runs in the Worker vs. what's delegated out
- **Real, self-contained Worker code (D1 + R2, no external service):** project/job bookkeeping,
  video upload, caption editing, style presets/brand styles, usage metering, WhatsApp delivery.
- **Real, but one external HTTP call:** transcription — a single request to an
  OpenAI-Whisper-compatible endpoint. No orchestration needed, so this runs inline inside the
  request. When the render pipeline is configured, that call is made *by the render pipeline*
  (`MARKETING_TRANSCRIBE_API_KEY`/`MARKETING_TRANSCRIBE_API_URL` live there, not in `wrangler.toml`
  — see "Transcription routing" below for why); otherwise the Worker calls it directly using its
  own `MARKETING_TRANSCRIBE_API_KEY` secret, same as before.
- **Genuinely delegated to an external pipeline the operator configures:** rendering — cropping to
  the target aspect, burning in captions, silence-cut, auto-zoom, background music + ducking,
  watermarking. **A Cloudflare Worker cannot do this** — there's no ffmpeg, no GPU, and a captioned
  9:16 export is minutes of CPU work, far past what a Worker request allows. Until
  `MARKETING_RENDER_WEBHOOK_URL`/`MARKETING_RENDER_WEBHOOK_SECRET` are set, render requests fail
  immediately with a clear "not configured" error instead of hanging.

### Schema — Cloudflare D1 (`env.DB`, `migrations/0015_marketing_studio.sql`)
Same "genuinely new data shape, no existing NocoDB reader" reasoning as `ecom_categories`/
`review_config` — nothing else in the app reads a video project or a render job.
- **`marketing_projects`** — one row per video project: `source_key`/`source_duration_sec` (R2 key
  + browser-reported duration — the Worker never decodes video itself), `target_aspect`
  (`9:16`/`1:1`/`16:9`), `trim_start_sec`/`trim_end_sec`, `language`, `transcript_json` (raw,
  never edited) + `captions_json` (editable copy the caption editor writes to), `style_id`
  (a preset id, or `custom:<marketing_brand_styles.id>`) + `style_overrides_json`, `status`
  (`uploading → uploaded → transcribing → ready → rendering → done`, or `failed` at any step —
  failures revert to the nearest retryable status, not stuck), `output_key`/`output_url`/
  `output_duration_sec`/`watermarked` (set by the render-complete webhook).
- **`marketing_brand_styles`** — saved custom font/color presets ("custom brand style saving",
  feature #8) on top of the static built-in presets (`MARKETING_STYLE_PRESETS` in `worker.js` —
  8 presets, no table needed since they never change per-client).
- **`marketing_jobs`** — one row per transcribe/render attempt (`type`, `status`, `spec_json`,
  `error`). Transcription rows are created and completed within the same request; render rows are
  created `queued`→`processing` here and finished later by the render-complete webhook.

### Schema — Clients table (`mxl33bg4wi70fqj`), add manually in NocoDB
- `feat_marketing_studio_enabled` (Single line text, `Yes`/`No`) — auto-created on first Save from
  the Modules page (`ensureMarketingStudioEnabledColumn`, same pattern as
  `ensureHospitalityEnabledColumn`), same as every other `feat_*`/`*_enabled` flag in this file.
- `marketing_minutes_used` (**Number**) / `marketing_minutes_limit` (**Number**) — usage metering
  (feature #18), same shape as `wa_credits_balance`: **not** auto-created (NocoDB Number fields
  need their type set correctly, which the SingleLineText auto-create helpers don't do), add these
  by hand. `marketing_minutes_used` increments by `ceil(rendered_duration_sec / 60)` each time a
  render completes (`handleMarketingRenderWebhook`); reset it to 0 manually (or via a scheduled
  admin task, not built here) at the start of each billing period. `marketing_minutes_limit` is set
  per client to match their plan tier (Basic/Growth/Advance); if left blank,
  `MARKETING_DEFAULT_MINUTES_LIMIT` (a `wrangler.toml` var, default `30`) is used instead.

### Backend (`cloudflare-worker/worker.js` — "MARKETING STUDIO MODULE" block)
All routes session-gated via `requireSession`/`payload.cid`, deriving the client from the session
like `/email/*`, never a client-supplied id — except the two routes below marked public.
- `GET /marketing/usage` — `{used, limit, remaining}` for the usage meter in the header.
- `GET /marketing/styles/presets` — the static 8-preset list.
- `GET/POST/DELETE /marketing/brand-styles` — custom style CRUD (no PATCH — delete and recreate;
  nothing here is expensive enough to need in-place editing).
- `GET/POST/PATCH/DELETE /marketing/projects` — project CRUD. `DELETE` also removes the project's
  R2 objects (source + output, if any) and its `marketing_jobs` rows.
- `POST /marketing/projects/upload-init` + `POST /marketing/projects/upload-finish` — direct
  browser-to-R2 upload, **not** a multipart body through the Worker. The old single-step upload
  route hit Cloudflare Workers' own request-body ceiling (~100 MB on most plans — not a limit this
  app chose); no application-level limit could raise that, since the platform rejects an
  oversized request before the Worker's own code ever runs. `upload-init` returns a short-lived
  (1 hour) presigned R2 `PUT` URL (`marketingR2PresignUrl` — hand-rolled AWS SigV4 query-string
  signing against Web Crypto, since Workers can't bundle npm packages like `aws4fetch` the way
  `render-pipeline`'s Node service can) and the R2 key the file will land at; the browser `PUT`s
  the file straight to R2 with it (the Worker's own body limit is irrelevant — it never receives
  the file bytes), then calls `upload-finish` with that key, which confirms the object actually
  exists in R2 (`env.MARKETING_MEDIA.head(key)` — guards against a client claiming a successful
  upload that never happened) and does the same D1 bookkeeping the old single-step handler did.
  `MARKETING_SOURCE_MAX_BYTES` (now a real, chosen 2 GB application limit, not a platform
  workaround) is enforced against the actual uploaded object's size at `upload-finish` time,
  deleting it from R2 if it's over. Accepts mp4/mov/webm/m4v. The multi-clip upload route
  (`POST /marketing/projects/clips/upload-init`/`upload-finish`) uses the identical pattern.
  **Requires new Worker secrets**: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET_NAME` — reuse the same R2 API token `render-pipeline` already has (same bucket,
  `leadvyne-marketing-media`), just also add it to the Worker via `wrangler secret put`. Without
  these, `upload-init` returns a clear "not configured" error rather than silently failing.
  **What's verified vs. not**: the SigV4 signing algorithm's HMAC-chain signing-key derivation was
  cross-checked byte-for-byte against Node's independent `crypto` module for a fixed test vector,
  and the canonical-request/presigned-URL structure was confirmed against AWS's documented S3
  format — the exact function as it exists in `worker.js` was then run for real, producing a
  correctly-structured, correctly-encoded presigned URL with a valid 64-character signature. What
  wasn't verified: an actual signed PUT against live R2 (no R2 credentials were available in the
  dev sandbox this was built in) — test a real large upload once the four secrets above are set.
- `POST /marketing/projects/transcribe` — the one inline external call described above. Requests
  `verbose_json` + word-level timestamps; **not every OpenAI-Whisper-compatible provider actually
  returns word timestamps** even when asked (some self-hosted front-ends only return segment-level
  timing) — `marketingWordsFromTranscription()` falls back to splitting each segment's text evenly
  across its duration, flagged `approximate:true` so the caption editor can show a dotted border on
  estimated words instead of silently presenting a guess as exact. Language: pass a hint to bias
  detection, or omit it to auto-detect (feature #4) — auto-detect and Malayalam/Manglish
  transcription quality (feature #6) are both properties of whichever provider
  `MARKETING_TRANSCRIBE_API_URL` points at, not something this Worker code can improve on its own.

#### Transcription routing — why this isn't a single, always-the-same code path
Two real problems with calling OpenAI's Whisper endpoint straight from `handleMarketingTranscribe`,
both **hit in production, not hypothetical**:
1. **The 25 MB request cap.** A video comfortably under the 100 MB upload ceiling can still exceed
   Whisper's 25 MB limit purely because it's a *video* file (picture data dwarfs audio data), not
   because the actual speech is long.
2. **OpenAI's country/region block.** OpenAI rejects API requests whose source IP resolves to
   certain countries/regions. Cloudflare Workers run on a globally distributed edge network with an
   unpredictable egress IP per request — calling OpenAI directly from the Worker hit this
   (`"Country, region, or territory not supported"`) for a real client project, even though the
   account's actual location is fine.

Both are fixed the same way: **when the render pipeline is configured**
(`MARKETING_RENDER_WEBHOOK_URL`/`SECRET`), this route calls its `POST /transcribe` endpoint
(HMAC-signed, same secret as `/render`/`/extract-audio` — see `render-pipeline/lib/transcribe.js`)
instead of calling OpenAI itself. The render pipeline extracts audio-only first (16kHz mono,
~64kbps — Whisper resamples to 16kHz internally regardless of input, so nothing is lost) — fixing
problem 1 — and, because it runs on one fixed host rather than Cloudflare's edge, has a stable
egress IP — fixing problem 2. **`MARKETING_TRANSCRIBE_API_KEY` therefore now lives on the render
pipeline** (`.env`/Coolify env var), not as a Worker secret.

**Without the render pipeline configured**, this route falls back to calling OpenAI directly from
the Worker using its own `MARKETING_TRANSCRIBE_API_KEY` secret (the original behavior) — still
capped at 25 MB as a raw video file, and still exposed to the country-block risk. This keeps
transcription working for a bare-Worker setup with no render pipeline deployed at all, just without
either fix.
**Manual step if you're moving from the old setup**: set `MARKETING_TRANSCRIBE_API_KEY` on the
render pipeline (Coolify env var — see `render-pipeline/.env.example`); the Worker's own
`MARKETING_TRANSCRIBE_API_KEY` secret can stay as a fallback or be removed once the render pipeline
is confirmed working.

**A third provider, Sarvam AI, handles Indic languages specifically.** Whisper's real-world
Malayalam accuracy turned out weak in production (mislabeled/garbled output on a real project).
When the render pipeline has `SARVAM_API_KEY` set and a project is tagged with a language Sarvam
supports (`hi`/`bn`/`kn`/`ml`/`mr`/`or`/`pa`/`ta`/`te`/`gu`/`en`), transcription routes there
instead of Whisper — chunked to fit Sarvam's 30-second-per-request cap (splitting at silence gaps,
not mid-word) and normalized back to the same word-timestamp shape everything downstream already
expects. See `render-pipeline/README.md`'s "Sarvam AI transcription for Indic languages" section
for the full writeup, including what's verified vs. not — the exact response field names for
word-level timestamps couldn't be confirmed against Sarvam's own (bot-protected) docs or a live
key in the dev sandbox this was built in, so it defensively falls back to approximate timing
rather than breaking if the real shape differs. **Manual step**: set `SARVAM_API_KEY` on the
render pipeline (Coolify env var) — reuse this app's existing Sarvam key if you already have one
for the WhatsApp voice-reply TTS feature.
- `PATCH /marketing/projects/captions` — saves the caption editor's edits (`captions_json`).
- `POST /marketing/projects/render` — see "The render pipeline contract" below.
- `GET /marketing/projects/jobs?project_id=` — recent job history/polling target for a project.
- `POST /marketing/projects/send-whatsapp` — direct send-to-WhatsApp (feature #17): a Graph API
  `type:video` message with the rendered clip's public R2 URL as the `link`, reusing the same
  `wa_phone_id`/`wa_token` credentials `handleWaSend` already uses — fits the existing WhatsApp
  infra rather than inventing a new delivery channel.
- `POST /marketing/webhook/render-complete` — **public** (no session token — the external render
  pipeline calls this, not the dashboard). Authenticated via `MARKETING_RENDER_WEBHOOK_SECRET`
  instead: an HMAC-SHA256-over-the-raw-body signature in an `X-Signature` header, same scheme as
  `verifyShopifyWebhookHmac` just with a generic secret instead of a vendor-specific one.
- `GET /marketing/media/:key` — **public** R2 serve (same trust model as
  `handleEcomCategoryMediaServe`/`handleHospitalityMediaServe`: a `<video>` tag or WhatsApp's own
  media fetch can't send an `Authorization` header, and the key — `marketing/<client>/<project>/
  source.<ext>` or an operator-chosen output key — isn't guessable). Supports byte-range requests
  (`Range`/`206 Partial Content`) since the editor's preview player needs them to scrub — a plain
  full-body response stalls Safari's seek bar on anything but a tiny clip.

### The render pipeline contract (what an operator needs to build once)
`POST /marketing/projects/render` builds a full render spec and POSTs it, HMAC-signed, to
`MARKETING_RENDER_WEBHOOK_URL`:
```json
{
  "job_id": 123, "client_id": 45, "project_id": 67,
  "callback_url": "https://leadvyne-api-proxy.leadvyne.workers.dev/marketing/webhook/render-complete",
  "spec": {
    "source_url": "https://.../marketing/media/marketing/45/67/source.mp4",
    "trim_start_sec": 4.2, "trim_end_sec": 38.9,
    "target_aspect": "9:16", "resolution": "1080x1920",
    "captions": {"language": "ml", "text": "...", "words": [{"word": "hi", "start": 4.3, "end": 4.5}, "..."]},
    "style": {"font": "...", "text_color": "#fff", "highlight_color": "#FFE600", "bg_style": "none", "position": "bottom", "animation": "pop"},
    "silence_cut": true, "auto_zoom": false, "background_music": "upbeat", "watermark": true
  }
}
```
Signature: `X-Signature` header = base64(HMAC-SHA256(raw JSON body, `MARKETING_RENDER_WEBHOOK_SECRET`)).
The pipeline is expected to render asynchronously and call back:
```json
POST <callback_url>
X-Signature: <same HMAC scheme, over this raw body, same shared secret>
{"job_id": 123, "status": "done", "output_url": "https://cdn.example.com/45/67/out.mp4", "duration_sec": 34.7}
```
(or `{"job_id":123,"status":"failed","error":"..."}`). `output_key` (an R2 key inside
`MARKETING_MEDIA`, served back via `GET /marketing/media/:key`) works instead of `output_url` if
the pipeline prefers to hand the finished file back to this Worker's own R2 bucket rather than
hosting it itself — either is accepted. On `done`, `marketing_minutes_used` increments by
`ceil(duration_sec / 60)`.

**A real implementation of this pipeline now lives in `render-pipeline/`** — a self-hosted Node +
ffmpeg service speaking exactly this contract (see `render-pipeline/README.md` for setup/
deployment via this repo's existing Coolify pattern). It's the default option; a paid video-API
route (Shotstack/Creatomate behind an n8n workflow, since this app already runs n8n) is still a
reasonable alternative if you'd rather not run/maintain ffmpeg yourself — either just needs to
speak this one request/callback contract.

### Frontend (`frontend/marketing-studio.html`)
Structured like `email-marketing.html` (own self-contained dark/purple CSS palette — deliberately
visually distinct, not shared with `dashboard.html`, to read as a genuinely different tool from the
messaging-focused Campaigns/Email Marketing pages): same `localStorage` (`lv_session`/`lv_cid`)
auto-login as those pages, only ever opened via `window.open()` from an already-logged-in
`dashboard.html` tab. Two tabs (Projects, Brand Styles) plus a per-project Editor view (opened from
a project row, not a tab) covering upload → trim (with a crop-guide overlay showing what the
target aspect keeps) → transcribe → tap-a-word-to-fix caption editing → style picker (with a live
caption preview drawn over the paused/playing source video — cosmetic only, the actual burn-in
happens on the render pipeline) → auto-edit toggles → render/export/download/WhatsApp-send, with
5-second polling while a project is `transcribing`/`rendering`.
`dashboard.html` — a `🎬 Marketing Studio` quick-action button (Home hero + Quick Actions card),
shown only when `feat_marketing_studio_enabled==='Yes'`
(`updateMarketingStudioVisibility`, called from `showApp()` and after saving the toggle), plus the
toggle itself in Settings → 🧩 Modules → Industry Modules.

### Known limitations / deferred (scoped, not built yet)
- **No real background job queue for rendering beyond the `marketing_jobs` table + webhook** — no
  retry-on-timeout, no dead-letter handling if the external pipeline never calls back. A render
  stuck in `processing` with no callback just stays there; there's no sweep to time it out (unlike,
  say, `sweepAbandonedShopifyCheckouts`'s cron). Worth adding if silent stuck renders turn out to be
  a real support burden.
- **2-3 clip variants from one video (feature #13)** — the data model supports creating multiple
  `marketing_projects` rows from the same uploaded source (re-upload isn't required — a second
  project could reuse another project's `source_key`, though nothing in the UI does this
  automatically yet) and rendering each with different trim points/styles, but nothing auto-suggests
  hook/cut points. Genuinely deferred, not stubbed.
- **Emoji auto-insertion on keywords (feature #9)** — not built. Would slot into the caption editor
  as a client-side keyword→emoji pass over `captions_json` before saving; cheap to add later.
- **Team/multi-user access (feature #20)** — not separately built because it doesn't need to be:
  this module reuses the same session/`team_emails` access every other page in this app already
  has (see `getClientByAuthentikEmail`'s team-email lookup) — any teammate who can log into the CRM
  can open Marketing Studio once it's enabled.
- **Project history/library (feature #19)** — the Projects tab already is this (list of past
  uploads, reopenable/re-editable via the Editor), so nothing further was needed here.

## Marketing Studio module — Video Templates ("create videos using code instead of editing")
A second way to produce videos in this module, alongside the upload-and-caption flow above:
instead of starting from one uploaded video, define a reusable **template** — a JSON scene spec
with `{{variable}}` placeholders — once, then batch-generate a whole set of videos from a list of
data rows in one request (one video per row: a headline/image/CTA per product, a name/offer per
lead, etc). Inspired by the "code instead of editing, generate hundreds of videos automatically"
pitch of tools like HeyGen HyperFrames — landing-page teasers, product demos, ads, and social
clips at data-driven scale rather than one video at a time in the Editor.

### Schema — Cloudflare D1 (`migrations/0016_marketing_templates.sql`)
- **`marketing_templates`** — `scenes_json` (the scene array — each scene's string fields, e.g.
  `content`, may contain `{{key}}` placeholders), `target_aspect`, `style_id` (a preset or
  `custom:<marketing_brand_styles.id>`, same resolution as a regular project), and
  `estimated_duration_sec` — an author-set estimate (not measured) used only for the pre-generate
  usage/minutes check, since the real duration of a template-rendered video isn't known until the
  external pipeline actually renders it.
- **`marketing_projects`** gained two columns: `template_id` and `template_vars_json` (the
  specific row of variables that produced this project). A template-generated project is
  otherwise an ordinary `marketing_projects` row — it appears in the normal Projects list,
  downloads/WhatsApp-sends the same way — these two columns just record provenance.

### Backend (`cloudflare-worker/worker.js` — "VIDEO TEMPLATES" block)
- `GET/POST/PATCH/DELETE /marketing/templates` — template CRUD, session-gated like every other
  route in this module.
- `POST /marketing/templates/generate` — `{template_id, rows:[{...vars}, ...]}`. For each row: (1)
  `marketingResolveScenes()` does dumb `{{key}}` string substitution across every scene field —
  deliberately not a templating engine/dependency, matching the "it's code, not a visual editor"
  framing without pulling one in for eight scene fields, (2) inserts one `marketing_projects` row
  (`status:'ready'`, `template_id`/`template_vars_json` set, no `source_key` — there's no uploaded
  video for a template-generated project), (3) submits a render job via the same
  `marketingSubmitRenderJob()` used by the regular Editor's render step, just with a
  `spec.mode:'template'` payload (`scenes` instead of `source_url`/`captions`) instead of
  `mode:'caption-clip'` — **the external render pipeline needs to handle both `spec.mode` values**;
  see the render spec examples in the section above and add scene-composition support alongside
  whatever renders the caption-clip mode.
  Capped at `MARKETING_TEMPLATE_BATCH_MAX` (100) rows per call — "hundreds automatically" is the
  pitch, but an unbounded fan-out from one request would mean unbounded render jobs and unbounded
  minutes spend in one shot; generate further batches for more than 100 videos. Usage-checked
  up front (`rows.length × ceil(estimated_duration_sec/60)` against remaining minutes) before any
  jobs are created. Partial failure is expected at this scale — every row is attempted regardless
  of earlier rows' outcome, and the response is a per-row `{project_id, ok, error}` list rather
  than an all-or-nothing result.
- `marketingResolveStyle()`/`marketingIsWatermarked()`/`marketingSubmitRenderJob()` were factored
  out of `handleMarketingRenderStart` (previously inline there) specifically so this generate path
  could reuse the exact same style-resolution, watermark, and job-submission logic rather than
  duplicating it — the one refactor this feature needed in the existing code.

### Frontend (`frontend/marketing-studio.html`)
New **🧩 Video Templates** tab: a template list, a "New Template" form with a raw JSON `<textarea>`
scene editor (styled as a monospace code box, not a WYSIWYG timeline — the point of this feature),
and a per-template "Generate batch" panel — another JSON `<textarea>` for the data rows, a
Generate button, and a per-row ✓/✗ result list. Generated videos don't get their own view here;
they show up in the ordinary Projects tab once each render completes, same polling/download/
WhatsApp-send flow as any other project.

### Known limitations / deferred
- **No CSV import for batch rows** — rows are pasted as a JSON array, not uploaded as a
  spreadsheet. A client with product/lead data in a CSV needs to convert it to JSON first (or this
  could read `ecom_categories`/Leads directly in a later phase — not built).
- **No scene preview** — unlike the caption-clip Editor's live overlay preview, a template's
  scenes aren't previewed in the browser before generating; the first real look at the result is
  the rendered output from the pipeline.
- **The external render pipeline must support `spec.mode:'template'`** — a pipeline built only for
  the original `mode:'caption-clip'` contract will reject or mishandle template-generated jobs
  until scene-composition support is added on that side.

## Marketing Studio module — Auto-Edit Templates & Cue Suggestions
Two small additions to the upload-and-caption flow, both **zero marginal cost** by design — no
new external API, no new billing surface:

### Auto-Edit Templates (`MARKETING_AUTOEDIT_PRESETS`, `migrations/` — no new table needed)
8 static presets (Talking Head, Highlight Reel, Tutorial, Testimonial, Product Ad, Vlog,
Announcement, Raw) bundling defaults for the render options that already existed
(`silence_cut`/`auto_zoom`/`background_music`) plus a new `broll_density` hint
(`low`/`medium`/`high`/`none`) the external pipeline can use if it generates its own B-roll beyond
the suggested cues below. `GET /marketing/autoedit-presets` returns the list; picking one in the
Editor's step 3 just pre-fills the existing toggles (`applyAutoeditPreset()` in
`marketing-studio.html`) — still hand-editable afterwards, and an explicit toggle always wins over
the preset's value (`handleMarketingRenderStart`'s `opts.x!==undefined ? opts.x : preset?.x`
precedence). No cost: this is static config, same shape as `MARKETING_STYLE_PRESETS`.

### Cue suggestions (B-Roll / SFX / VFX, `migrations/0017_marketing_cues.sql`)
Answers "can it add B-roll/SFX/VFX based on the script": it can **suggest where** to add them,
for free, from the transcript this module already has — actually compositing that B-roll clip,
playing that SFX, or applying that VFX still happens on the external render pipeline, same
"suggest and pass through" boundary as everything else this module delegates.
- `marketing_projects.cues_json` — one row's suggested/accepted cues:
  `[{start, end, type:'broll'|'sfx'|'vfx', tag, label, keyword, accepted}]`.
- `marketingSuggestCuesHeuristic()` (`worker.js`) — **pure function, no external call**: scans the
  transcript's words against `MARKETING_CUE_KEYWORDS`, a static ~15-entry keyword→cue-type
  dictionary (e.g. "discount"/"price" → a money B-roll shot, "wow"/"amazing" → a sparkle SFX
  sting, "compare"/"versus" → a split-screen VFX). Caps at 20 cues and enforces a 2.5s minimum gap
  between suggestions so a keyword-dense script doesn't produce an unusable wall of them. This is
  a deliberately blunt heuristic, not a model call — the tradeoff for staying at $0/project. A
  natural (not built) upgrade: reuse the `GEMINI_API_KEY` this app already shares with the
  Conversation Engine for one cheap `gemini-1.5-flash`-class call over the transcript text,
  gated behind an explicit opt-in action so the free path stays the default.
- `POST /marketing/projects/suggest-cues` — runs the heuristic, saves the result (all
  `accepted:true` by default), returns it. `PATCH /marketing/projects/cues` — saves the editor's
  accept/reject/remove edits. Both session-gated like every other route in this module.
- Only cues with `accepted!==false` are included in the render spec's new `cues` array
  (`handleMarketingRenderStart`) — the external pipeline reads `spec.cues` (each with a
  `start`/`end`/`type`/`tag`/`label`) to decide what to actually drop in at each timestamp; what
  asset library it pulls a "money shot" or a "whoosh transition" from is entirely up to that
  pipeline, same as it already owns caption burn-in, cropping, silence-cut, etc.
- Frontend: Editor step 4 ("B-Roll / SFX / VFX cues") — a "✨ Suggest cues from script" button
  (disabled until captions exist), a checkbox+remove list per suggestion, and a Save button.
- **B-roll compositing now self-sources footage, not just suggests it.** Previously an accepted
  B-roll cue silently did nothing at render time unless the operator had manually dropped a
  matching file in `assets/broll/`. `render-pipeline/lib/assets.js`'s `resolveBroll` now falls
  back to fetching a real royalty-free clip from Pexels' free stock video API (`PEXELS_API_KEY`)
  the first time a given cue tag is used, caching it to `assets/broll/<tag>.mp4` afterward — one
  API call per tag, ever, not per render. SFX/music still require a manually-dropped file (no
  free, redistributable stock audio API used here). Verified for real: a mocked Pexels response
  (matching the real API's documented field names — `videos[].video_files[].link`/`quality`/
  `width`/`height`) was resolved, downloaded, and cached correctly, and a second call for the same
  tag was confirmed to hit the cache instead of calling Pexels again. **Manual step**: set
  `PEXELS_API_KEY` on the render pipeline (Coolify env var) — free at pexels.com/api.

## Marketing Studio module — Scene detection & per-scene editing (`migrations/0020_marketing_scenes.sql`, `0021_marketing_preview.sql`)
A larger "make the editor more like CapCut" effort, built in phases (real scene/shot-cut
detection + per-scene caption grouping, then thumbnails + a visual timeline, then apply/preview
renders — all four described below are built; a full drag/resize-editable timeline is not, see
"What's not built" at the end).
- **`marketing_projects.scenes_json`** — the detected scene boundaries, `[{start,end}, ...]`
  (seconds, in the source video's own timebase). Detection itself runs on the render pipeline
  (`render-pipeline/lib/sceneDetect.js` — real ffmpeg frame-difference analysis via the `scene`
  filter, not a heuristic); this column just stores the result.
- `POST /marketing/projects/detect-scenes` — session-gated, calls the render pipeline's
  `POST /detect-scenes` (HMAC-signed, same secret as every other render-pipeline call) and saves
  the result. Requires the render pipeline configured, same as transcription/rendering.
- **Auto-runs once after a successful transcribe** (`transcribeProject()` in
  `marketing-studio.html`, same pattern as the existing auto-suggest-cues call) if the project has
  no scenes yet — a re-transcribe doesn't silently discard scene boundaries you may have already
  reviewed or split.
- **Frontend**: the Editor's step 1 word list is now grouped into labeled scene blocks
  (`renderWordGroups()`) instead of one flat list, each with a **"✂ Split evenly"** button
  (`splitSceneEvenly()`) — this is the direct fix for a real production issue: a transcription
  provider that only returns one coarse chunk covering an entire scene (seen in practice with the
  Sarvam integration above) previously had no good way to fix the timing short of manually
  re-typing every word; "split evenly" re-distributes that scene's words evenly across *that
  scene's own* start/end, which is meaningfully more accurate than the existing clip-wide
  approximate-timing fallback when the coarse chunk happens to align with a scene boundary (a
  transcription provider's own sentence/segment breaks often do, in practice).
- **What's verified vs. not**: the detection algorithm itself was tested against real synthetic
  video (multi-scene, no-cut, and merge-close-cuts cases — see `render-pipeline/README.md`'s
  "What it actually does") and the scene-grouping/split-evenly logic was tested with the exact
  Malayalam text from a real production transcription that came back as one coarse chunk,
  confirming it correctly splits into individually-timed words across the scene's real duration.
  **Not verified**: detection accuracy/threshold tuning against a real, non-synthetic marketing
  video (talking-head footage, natural cuts) — the 0.3 threshold is ffmpeg's own commonly-cited
  starting point, not tuned against this app's actual use case yet.

### Scene thumbnails & the visual Timeline
- **`generateSceneThumbnails()`** (`render-pipeline/lib/sceneDetect.js`) — one small (240px) JPEG
  per scene, captured slightly into the scene (not the exact cut frame, which can still be
  mid-transition on real footage), uploaded through the same `uploadOutput` helper renders already
  use (extended with an optional `contentType` param — `image/jpeg` here, `video/mp4` elsewhere).
  Best-effort: a single thumbnail failing doesn't fail scene detection as a whole. Attached to each
  scene as `thumbnail_url` by the Worker (`handleMarketingDetectScenes`, same `output_key`/
  `output_url` resolution the render-complete webhook already does for R2 vs. local-fallback
  mode).
- **Timeline** (`renderTimeline()`, a full-width card above the editor's two columns) — real scene
  tiles (showing the thumbnail, sized proportionally to that scene's own duration via CSS flex,
  not a fixed grid) and a cue-marks row below them (B-Roll/SFX/VFX cues color-coded, positioned by
  percentage of total duration). Click a scene tile to jump to its caption block below
  (`jumpToScene`); click a cue mark to jump to the Cues step. **Not** drag/resize-editable — this
  is a real, correctly-positioned visualization + click-to-jump, not the full manipulation a
  timeline UI usually implies; that's further work, not built.

### Apply/preview renders (`migrations/0021_marketing_preview.sql`)
"Need apply button before render" / "apply button for overlay, sfx, vfx, change for each scene" —
a real short (capped at 12s), draft-quality render of the CURRENT auto-edit toggles and accepted
cues, so they can be checked before committing to the full render, instead of only finding out
what silence-cut/auto-zoom/B-roll/SFX/VFX actually look like after a full-length render finishes.
- `POST /marketing/projects/preview` (`handleMarketingPreview`) — same spec-building as a real
  render (factored out into `marketingBuildRenderSpec`, shared by both `handleMarketingRenderStart`
  and this, so a preview can never silently drift from what the real render would do), but trimmed
  to at most 12 seconds (from the clip's trim-start, or from a specific scene's own start if
  `scene_index` is given — still capped at 12s even then) and quality forced to `draft`.
- **Never touches the project's real state.** `marketingSubmitRenderJob` gained `jobType`/
  `updateProjectStatus` params — a preview submits with `jobType:'preview'`,
  `updateProjectStatus:false`, so it doesn't flip the project to `status:'rendering'` and, on
  completion, `handleMarketingRenderWebhook`'s `job.type==='preview'` branch skips overwriting
  `output_key`/`output_url`/`status` and skips `marketing_minutes_used` billing entirely — a
  preview costs render-pipeline compute but never counts against the client's metered minutes.
  Its result lives on the **job row itself** (`marketing_jobs.output_url`, new column) instead,
  read via the existing `GET /marketing/projects/jobs` list.
- **Frontend**: "🔍 Preview (first 12s)" buttons on the Auto-edit and Cues steps, plus a small
  "🔍 Preview" button on every scene block (previews just that scene, still ≤12s) — each posts to
  `/preview`, then polls `GET /marketing/projects/jobs` on its own 3s timer (`pollPreviewJob`,
  deliberately separate from the existing `pollJobsIfNeeded`, since that one keys off
  `currentProject.status`, which previews never change) until the job's own `status`/`output_url`
  show up, then plays the result inline right where the button was clicked.
- **What's verified vs. not**: the shared spec-building refactor and the webhook's type-branching
  logic were reviewed for correctness against the existing (unchanged-behavior) real-render path;
  `node --check` passed on all changed files. **Not verified**: an actual live preview render
  end-to-end (needs a deployed render pipeline + a real project — not runnable in the dev sandbox
  this was built in). Test one after deploying.

### Recovering from bad transcription timing, and add/delete captions
Two real gaps found in production use of the scene grouping above:
- **"Fix timing across scenes"** (`redistributeCaptionsAcrossScenes()`) — `splitSceneEvenly` only
  helps when a coarse transcription chunk's *text* is at least in the right scene; in production,
  a transcription provider returned one chunk with time bounds confined to a small fraction of the
  real clip (e.g. the whole transcript timestamped 0–6s of a 25s, 6-scene video), dumping every
  word into scene 1 regardless of what was actually said when. This button takes the FULL
  transcript's text and redistributes it across every detected scene, proportional to that scene's
  own duration — real, tested recovery (see the frontend's inline test), not a full fix for
  whatever is wrong with the underlying transcription timestamps (still the same unresolved Sarvam
  response-shape uncertainty noted above).
- **Add/delete caption words** — previously only editing existing words was possible. Clearing a
  word's text and clicking away now deletes it (was: silently reverted); Escape still cancels an
  edit without deleting. Each scene got a **"+ Add word"** button that inserts a new word at the
  end of that scene's current words (or at the scene's start if it has none) and immediately opens
  it for editing.

### What's not built (honest scope note)
A full CapCut-style timeline — dragging scenes to reorder/trim, resizing cue markers by dragging
their edges, multi-track drag-and-drop — is a materially bigger UI engineering effort than what's
here (real mouse-drag interaction state, collision handling, live re-computation of every
downstream time value) and was deliberately scoped out rather than attempted half-built. What
exists today is real and useful (detection, grouping, thumbnails, a correctly-positioned timeline
visualization, working preview renders) but is click-based, not drag-based.

## Marketing Studio module — Client-level API keys, more free sources & AI B-roll (`migrations/0022_marketing_client_settings.sql`)
Answers "give me more Auto-Edit/B-Roll/SFX/VFX options with free APIs, and let each client bring
their own keys instead of one shared server default."

### Client-level API keys (`marketing_client_settings`)
One row per client, nullable key columns (`pexels_api_key`, `pixabay_api_key`,
`freesound_api_key`, `fal_api_key`) — `NULL` means "fall back to the shared server env var," not
"disabled." Lets each client bring their own account/quota/billing for these external sources
instead of sharing one server-wide key.
- `GET /marketing/settings/api-keys` — returns each key **masked** (`marketingMaskKey`: last 4
  characters only, e.g. `••••ab12`); the real value is never sent back to the frontend once saved.
- `POST /marketing/settings/api-keys` — partial update (only fields present in the body change);
  sending an empty string for a field explicitly clears it back to "use shared default" (distinct
  from omitting the field, which leaves it untouched). Frontend: Editor's new "🔑 API Keys" tab,
  one password input + a dedicated "✕ Clear" button per field (needed because password inputs are
  always blank on load, so a blank field alone can't distinguish "untouched" from "clear this").
- `marketingGetClientKeys(env, clientId)` — the only place the real (unmasked) values are read;
  called server-side when building a render spec (`marketingBuildRenderSpec`) and folded into
  `spec.client_keys`, which the render pipeline consults before falling back to its own env vars
  (`PEXELS_API_KEY`/`PIXABAY_API_KEY`/`FREESOUND_API_KEY` — `render-pipeline/lib/assets.js`'s
  `apiKeyFor()` helper: `clientKeys?.[field] || env?.[envVarName]`).

### Pixabay — second free B-roll source
`fetchFromPixabay()` (`render-pipeline/lib/assets.js`) — tried as a fallback when Pexels has no
key configured or returns nothing for a tag. Auth via `key=` query param (not a header); response
shape `{hits:[{videos:{large,medium,small,tiny}:{url}}]}`, walked large→tiny for the first
available quality tier (Pixabay's video search has no orientation/portrait filter, unlike its
image API — same "gets scaled/cropped to the target resolution anyway" reasoning the existing
Pexels 720p-floor logic already relies on). **Manual step**: set `PIXABAY_API_KEY` (shared
default) and/or let clients set their own under 🔑 API Keys — free at pixabay.com/api/docs.

### Freesound.org — free SFX auto-fetch
Previously SFX cues required a manually-dropped file in `assets/sfx/`; `fetchFromFreesound()`
mirrors the B-roll auto-fetch pattern. Auth via `token=` query param — confirmed via Freesound's
own docs that **preview-quality files need no OAuth2** (only the full-quality Download endpoint
does), which is what makes this viable for a server-to-server call with no interactive user in the
loop. Query: `filter=duration:[0.2 TO 6]&sort=score`, picks the first hit's
`previews['preview-hq-mp3']` (falling back to `preview-lq-mp3`) — short stings, quality difference
is inaudible at this length. Cached to `assets/sfx/<tag>.mp3` on first use per tag, same as B-roll.
**Manual step**: set `FREESOUND_API_KEY` (shared default) and/or per-client — free at
freesound.org/apiv2/apply (a normal API key, issued instantly, no approval wait).

### Filler-word removal
The existing "✂️ Cut silences / filler words" chip's label already promised this before the code
did it — now it actually does both. Zero new mechanism: `render-pipeline/lib/fillerWords.js`'s
`findFillerWordRanges()` reuses the exact same `computeKeepSegments`/`makeTimeMapper` machinery
silence-cut already uses (a cut range is a cut range, regardless of *why*), so filler-word ranges
just get merged in alongside silence ranges before the single remap pass. Filler words are also
filtered out of the caption word list itself (not just cut from the audio), since captioning a
word whose audio was just removed would show text with nothing behind it. `FILLER_WORDS` is a
small English set (um, uh, hmm, like, er, ...) — **does not cover Malayalam or other
non-English filler words**, a real gap, not attempted here; a genuine future addition would need a
per-language filler-word list, not a bigger English one.

### AI B-roll generation (fal.ai) — **paid, not free**
Unlike Pexels/Pixabay/Freesound above, fal.ai is a real per-second cost (roughly $0.05–$0.40/sec
depending on model as of researching this) — flagged to the user before building, not silently
integrated. **Requires a client-supplied `fal_api_key`** (🔑 API Keys tab) — there is no shared
server default for this one field, so a client's own generation spend always bills to their own
fal.ai account, never a shared key covering everyone's usage.
- Use case: a B-roll cue whose tag has no good stock match (or a client just wants
  purpose-generated footage) — an inline prompt field + "🎬 AI B-roll" button next to each B-roll
  cue in the Cues step (`generateAiBroll()`/`pollAiBrollJob()` in `marketing-studio.html`).
- `POST /marketing/projects/generate-ai-broll` (`handleMarketingGenerateAiBroll`) — validates the
  project and the client's fal.ai key, then submits a job on the **same job queue/webhook
  machinery every render already uses** (`marketingSubmitRenderJob(..., 'ai_broll', false)`) rather
  than new infrastructure — a multi-minute AI generation is exactly the kind of job this pipeline's
  existing async queue+callback pattern already exists for. `handleMarketingRenderWebhook`'s
  project-state-mutation branch excludes `job.type==='ai_broll'` the same way it already excludes
  `'preview'` — generation never touches the project's `output_key`/`status`/billed minutes.
- `render-pipeline/lib/falBroll.js` — submits to fal.ai's queue API
  (`POST https://queue.fal.run/{model}`, `Authorization: Key <key>` header, model
  `fal-ai/wan/v2.7/text-to-video`), then **polls** (not webhooks — avoids standing up a new public
  inbound endpoint + signature verification just for this one feature) every 5s for up to 5 minutes.
  Result is downloaded and cached to `assets/broll/<tag>.mp4` — the exact same path/convention
  Pexels/Pixabay use, so a render started right after generation completes finds it automatically
  through the normal local-file lookup in `resolveBroll`, no separate "AI broll" code path at
  render time. The frontend's status only ever shows "✅ Ready — used automatically in your next
  render/preview," not an inline video preview, since the generated file lives on the render
  pipeline's local disk, not a public R2 URL.
- **What's verified vs. not**: the queue submit/status endpoints, the `Authorization: Key <key>`
  header, and the polling approach are confirmed against fal.ai's own documentation. The exact
  result payload field (`result.video.url`) is corroborated only by third-party
  docs/code-examples quoting this model's API, **not** fal's own docs directly and **not** tested
  against a real fal.ai key (none was available in the dev sandbox this was built in) — the polling
  code defensively checks a couple of plausible field locations, and if a real generation completes
  with none matching, the error message includes the actual response so the field name can be
  corrected in one place (`extractVideoUrl()` in `falBroll.js`). **Test with a real fal.ai key
  after deploying before relying on this.**

## Marketing Studio module — CapCut-style extras (speed ramp, denoise, chroma key, batch export, social caption, auto-reframe, beat sync, translate, voiceover)
A batch of further CapCut-style features, all free (no paid API — MyMemory and espeak-ng both need
no key at all; everything else is pure ffmpeg or reuses the free local RVM model already running
for Text Behind Subject). All render-affecting options here ride the same `spec` object and Editor
step 3 chip row as the existing silence-cut/auto-zoom toggles.

- **Global speed ramp** (`spec.speed_factor`, 0.5–2×) — a single clip-wide speed change
  (slow-mo/time-lapse), applied as the LAST step in `filtergraph.js` (`setpts`/`atempo`), after
  captions are already burned in and audio already mixed — both simply play back faster/slower
  together, no caption-timing recomputation needed. **Not** CapCut's full per-segment speed
  *ramping* (varying speed within one clip) — a real, deliberate v1 scope limit, not a bug.
  Verified for real: ran the full filter graph (chroma key + denoise + 1.5× speed together)
  through actual ffmpeg against synthetic video and confirmed the output duration matched exactly
  (6s input → 4.04s output at 1.5×).
- **Noise reduction** (`spec.denoise`) — ffmpeg's own built-in FFT denoiser (`afftdn`), applied to
  the speech track before music/SFX mixing. No external model file to ship (unlike RNNoise/
  `arnndn`) — genuinely zero extra setup or cost.
- **Green screen / chroma key** (`spec.chroma_key: {enabled, color, similarity, blend,
  background_color}`) — keys out the given color and composites onto a solid background color
  (an actual background *image* is a natural future addition, not built here — v1 is
  color-only). Hex colors are re-validated on BOTH the Worker (before signing the spec) and the
  render pipeline (`filtergraph.js`'s own `sanitizeHexColor`) — defense in depth, since these
  strings get interpolated straight into an ffmpeg filter expression.
- **Batch multi-aspect export** (`POST /marketing/projects/render` with `body.aspects: ['1:1',
  '16:9']`) — renders the project's own aspect as the normal primary render, plus any OTHER
  checked aspect as a `jobType:'render_extra'` job on the SAME queue — a real, separately-billed
  render (minutes billing runs for it too), but its result lives only on its own job row
  (`marketing_jobs.output_url`), same as a preview, since a project only has one `output_key`
  column. `handleMarketingRenderWebhook`'s project-row-mutation branch now checks
  `job.type==='render'` specifically (was `!=='preview'`) so `render_extra` jobs bill minutes
  without overwriting the project's canonical output.
- **Social caption + hashtags** (`POST /marketing/projects/suggest-caption`) — drafts a short
  social caption + 4-6 hashtags from the transcript, reusing the SAME shared `GEMINI_API_KEY` the
  Conversation Engine already calls (`engineGeminiGenerate`) — no new integration. Falls back to a
  plain heuristic (first sentence + generic hashtags) if no key is configured or the model call
  fails, so the button always returns something usable rather than erroring.
- **Smart auto-reframe** (`spec.auto_reframe`, `render-pipeline/lib/autoReframe.js`) — instead of
  always center-cropping a landscape/square source down to a taller aspect, tracks the subject's
  horizontal position (via the SAME local RobustVideoMatting model Text Behind Subject already
  runs — no new model, no per-video cost) and keeps them in frame. Computes a per-frame centroid
  from RVM's alpha output, smooths it (simple moving average — real jitter reduction, not a
  Kalman/optical-flow tracker), and builds an ffmpeg `crop` filter `x` expression entirely in
  terms of ffmpeg's own runtime `in_w`/`out_w` variables (resolution-independent, no baked-in
  pixel math). Best-effort: falls back to the existing static center-crop if matting fails
  (missing model file, decode error, no confident subject). **Verified for real**: a synthetic
  moving "subject" blob correctly produced a rightward-moving centroid track, and the resulting
  crop expression was run through actual ffmpeg (both standalone and inside the full filter graph)
  and confirmed to execute correctly — not just syntax-checked.
- **Beat-synced cuts** (`spec.beat_sync`, `render-pipeline/lib/beatDetect.js`) — snaps B-roll/SFX
  cue start times to the nearest detected beat in the background music, so cuts land "on the
  beat" like CapCut's auto-cut-to-beat. This is a real, from-scratch **energy-onset detector**
  (spectral-flux-style: half-wave-rectified frame-to-frame RMS energy increase, adaptive-threshold
  local-maxima peak-picking) — explicitly **not** a full tempo/beat-tracker like librosa's
  `beat_track` (no BPM-grid fitting or phase estimation), because that's what actually matters for
  short-form cut points, not a steady tempo claim. No new npm dependency — decodes PCM via the
  ffmpeg binary already required everywhere else in this pipeline. The music's own detected beat
  pattern is tiled across the full output duration to match how it loops in the final render
  (`-stream_loop -1`). **Verified for real**: built a synthetic 16-click track (500ms apart) via
  real ffmpeg and confirmed the detector found 15/16 clicks within 100ms (it structurally can't
  detect the very first onset at t=0, a known and reasonable onset-detector characteristic — no
  preceding energy to compare against).
- **Auto-translate captions** (`POST /marketing/projects/translate-captions`,
  [MyMemory Translation API](https://mymemory.translated.net/)) — genuinely free with **no API
  key or signup at all**: 5,000 chars/day anonymously by IP, or 50,000/day with a contact email
  set via the Worker's `MYMEMORY_EMAIL` (a shared server-level setting — it's a quota multiplier,
  not a real credential, so it's not per-client like the Pexels/Pixabay/Freesound/fal.ai keys).
  Splits the transcript into ~450-char chunks (MyMemory's own per-query limit is small) and
  translates sequentially (not in parallel — the daily quota is shared Worker-wide). **Word-level
  timing can't survive translation** (word count/order changes across languages) — translated
  words are evenly spread across the SAME total time span the original transcript covered, the
  same honest "equal split" approximation this module already uses elsewhere
  (`splitSceneEvenly`/`redistributeCaptionsAcrossScenes`) rather than a false claim of exact sync.
  Frontend shows a preview and requires an explicit "✅ Apply as captions" click — never silently
  overwrites existing captions. **Not verified against a live call** in the dev sandbox this was
  built in (outbound requests to arbitrary external hosts are proxied/blocked there) — the
  request/response contract (`GET .../get?q=...&langpair=src|tgt`, response at
  `responseData.translatedText`) is confirmed via MyMemory's own published documentation, not a
  live test. Test a real translation after deploying.
- **AI voiceover/dubbing (beta)** (`POST /marketing/projects/generate-voiceover`,
  `render-pipeline/lib/tts.js`) — free, fully local text-to-speech via **espeak-ng** (apt-
  installable, no API key, works offline). The honest tradeoff versus a paid neural TTS API
  (ElevenLabs etc.): espeak-ng is a formant/rule-based synthesizer and sounds clearly
  robotic/mechanical, not a studio-quality AI voice — documented upfront, not discovered after
  shipping. **v1 scope**: produces a real, downloadable/playable narration audio file (from the
  transcript, or custom typed text) — it does **not** automatically dub/time-align itself into the
  video render. The original speech and a synthesized voiceover of the same text generally run
  different lengths, and reconciling that against the existing silence-cut/caption-timing
  machinery is real additional work, not attempted here — a natural future addition. Runs
  synchronously on the render pipeline (`POST /synthesize-voiceover`, same HMAC-signed pattern as
  `/transcribe`/`/detect-scenes` — espeak-ng synthesis is fast enough not to need the async job
  queue a full video render uses). **Verified for real**: ran the actual espeak-ng → ffmpeg mp3
  pipeline end-to-end in the dev sandbox and confirmed a real, correctly-sized, correct-duration
  audio file was produced (not just that the commands parsed).

### Autosave for Auto-edit options & cues (`migrations/0023_marketing_autoedit_options.sql`)
A real UX gap, not just polish: cue checkboxes/removals in step 4 only ever mutated the browser's
in-memory `currentCues` array — a render reads the PROJECT's saved `cues_json`, so an unsaved
toggle silently had no effect on the actual render unless "💾 Save cues" was clicked first. Fixed
by autosaving (debounced, 600ms) on every cue check/uncheck/remove — the manual button still works
too, just isn't required anymore. Separately, the Auto-edit step's toggle/select picks (silence-
cut, auto-zoom, denoise, chroma key, auto-reframe, beat-sync, speed, music) previously lived only
as transient client-side flags (`p._optX`), reset on every reload — new column
`marketing_projects.autoedit_options_json` persists them, autosaved the same debounced way and
restored on `renderEditor()`. Note this is purely about the picks *surviving a reload* — a
Render/Preview click already reads current toggle state live off the DOM
(`collectRenderOptions()`), so nothing here was ever required for a render to pick up what's
currently selected; the confusion this fixes is specifically "I toggled/unchecked something and it
didn't seem to apply," which for cues was a real bug (the render pipeline literally never saw the
unsaved change), and for auto-edit toggles was persistence, not application.

### Deploy-state diagnostics (build tags)
Real, repeated confusion this session came from deploy *sequencing*, not code bugs: a stale local
git checkout before `wrangler deploy`, D1 migrations run before pulling the migration files, a
Coolify "redeploy" that restarted a cached image instead of rebuilding it. Two small additions
make that a 5-second check instead of a guessing game:
- `GET /health` on the Worker and `GET /health` on the render pipeline both now return a hand-
  bumped `build`/`marketing_build` tag (`MARKETING_BUILD_TAG` in `worker.js`, `BUILD_TAG` in
  `server.js` — kept in sync by hand, no shared source, since these are two separately-deployed
  services). The render pipeline's `/health` also reports `espeak_ng_available` and
  `rvm_model_present` — real checks (`spawnSync('espeak-ng', ...)`, `fs.existsSync(MODEL_PATH)`)
  of THIS running container, not just "the process didn't crash" — since those two specifically
  depend on Dockerfile steps that only run on a real image rebuild, not a restart.
- The Worker's build tag is also surfaced directly in Marketing Studio's header (next to the usage
  pill) via `GET /marketing/usage`'s new `build` field — no separate curl needed for the most
  common case.

### Custom caption fonts, incl. real Malayalam typefaces (`render-pipeline/fonts/`)
Captions previously could only use whatever font happened to be installed system-wide
(`fonts-liberation`/`fonts-noto-core`) — a real Malayalam typeface (Manjari, Meera, etc.) had no
way in. `render-pipeline/fonts/` is a new drop-in directory (mounted as a Coolify persistent
volume, same pattern as `assets/`): add a `.ttf`/`.otf` file, and it's usable on the very next
render — no rebuild, no fontconfig/`fc-cache` registration. Mechanism: ffmpeg's `subtitles` filter
has its own documented `fontsdir` option that makes libass read font files straight off that
directory at render time (`lib/filtergraph.js`, and `lib/textBehindSubject.js` for the "text
behind subject" pipeline's separate subtitles filter call) — genuinely simpler than the
fontconfig-registration approach, and immune to any font-cache staleness. Frontend: a "Custom font
family" field in Editor step 2 (Caption style), autosaving into the project's existing
`style_overrides_json` (a mechanism that already existed server-side but had no UI until now).
**Honest limitation**: the in-browser live caption preview can't actually render a font that only
exists as a file on the render-pipeline server (browsers don't have access to it) — it silently
falls back to a default typeface in the preview, while the real rendered video (server-side
libass) uses the correct custom font. See `render-pipeline/fonts/README.md` for suggested free/
open-license Malayalam fonts (not bundled — a licensing/repo-size decision, add the file yourself).

### Settings inspector & Sarvam raw-response logging
Two more debugging tools, added after repeated reports of "auto-edit/B-roll doesn't apply" and
"captions land in the wrong scene" that couldn't be root-caused remotely without real data:
- **"🔍 Inspect settings that will be sent"** (Editor step 5) — shows the EXACT JSON body
  `startRender()` is about to POST, plus a live re-fetch of what's actually saved server-side for
  cues right now (not just trusted from in-browser state) with an explicit mismatch warning if
  they differ. Directly answers "is my toggle/cue actually being applied" with real data instead
  of another guess.
- **`[SARVAM DEBUG]` logging** (`render-pipeline/lib/sarvamTranscribe.js`) — every chunk boundary
  and the FULL raw Sarvam response are now logged per transcription, distinctly tagged for easy
  grepping in render-pipeline logs. This integration's response-shape parsing was flagged
  genuinely unverified from the start (no live Sarvam key was available while building it — see
  the file's header comment) and has now shown a real production symptom (words landing in empty/
  wrong scenes, apparent duplicates) that can't be root-caused without seeing an actual response.
  Grab the render-pipeline logs around a transcription and the parser can finally be corrected
  against real data instead of plausible-shape guesses.

### Self-hosted transcription — faster-whisper (`WHISPER_LOCAL_ENABLED`, opt-in)
Requested as "add m-bain/whisperX and AI4Bharat" to fix the recurring Sarvam response-shape bug —
what actually shipped, and why it's not literally either of those:
- **whisperX itself failed to install** in real testing (`pip install whisperx`) — it hard-depends
  on `pyannote.audio` (for speaker diarization, a feature this app doesn't use), which transitively
  pulls in `antlr4-python3-runtime`, whose legacy sdist failed to build against a current
  setuptools. This wasn't a hypothetical concern raised and set aside — it's a real failure hit
  while building this.
- **AI4Bharat's Tamil/Malayalam coverage couldn't be confirmed.** WhisperX's actual differentiator
  over plain Whisper — per-language wav2vec2 forced alignment — needs a matching model; AI4Bharat's
  `IndicWav2Vec` models were confirmed to exist for Hindi/Odia/Bengali/Telugu
  (`ai4bharat/indicwav2vec-hindi` etc. on Hugging Face) but NOT confirmed for Tamil or Malayalam
  specifically — the two languages actually motivating this. Integrating AI4Bharat for languages
  it may not cover would've been the same kind of unverified guess that caused the Sarvam bug in
  the first place.
- **What shipped instead**: `faster-whisper` (the same CTranslate2-backed engine whisperX itself
  uses internally for transcription) — confirmed installing cleanly, and its own built-in
  `word_timestamps` option (DTW over cross-attention weights, not a separate per-language model)
  gives real word-level timing uniformly across every language Whisper supports, Tamil and
  Malayalam included. This is the actual substance of what "add whisperX" was for — self-hosted,
  no per-request API cost, no OpenAI country-block risk, and critically, a response shape
  confirmed by direct inspection of the installed package's dataclasses
  (`Segment.start/end/text/words`, `Word.word/start/end`) rather than guessed at from
  documentation, unlike the Sarvam integration this replaces the risk profile of.
- **`render-pipeline/asr/transcribe.py`** — the actual transcription script (spawned as a Python
  subprocess from `lib/whisperTranscribe.js`, same pattern as every other external binary this
  pipeline shells out to). **`lib/transcribe.js`**'s provider order: `WHISPER_LOCAL_ENABLED` (if
  set) → Sarvam (for its supported Indic languages, if `SARVAM_API_KEY` set) → OpenAI Whisper API.
  Entirely opt-in — doesn't change behavior for anyone who hasn't set the env var.
- **Real, measured cost**: installed packages (`ctranslate2`+`onnxruntime`+`av`, no PyTorch needed)
  total ~150-200MB — meaningfully lighter than a PyTorch-based stack would have been. The model
  itself (`WHISPER_MODEL_SIZE`, default `small` — chosen for CPU-only hosts, since a larger model
  is noticeably slower without a GPU) downloads lazily on first use, not baked into the image.
- **What's verified vs. not**: `pip install faster-whisper` succeeding cleanly, and every field
  name the parsing code relies on, were confirmed directly against the installed package in a real
  Python 3.11 environment — not assumed from memory or docs. **Not verified**: actual model
  download + inference end-to-end — this dev sandbox's outbound proxy returns 403 for
  huggingface.co, so no real transcription could be run here. The first real transcription after
  deploying will also be the first real test of this path — check it against a genuine Tamil or
  Malayalam video before trusting it over Sarvam.

### Self-hosted transcription — AI4Bharat IndicConformer (`AI4BHARAT_ENABLED`, opt-in)
After confirming whisperX's own install failure, the user explicitly asked for AI4Bharat
specifically ("AI4Bharat is fine, implement that, dont use whisperX if its heavy") — so this went
in as its own opt-in provider, not folded into the faster-whisper section above since it's a
meaningfully different tradeoff.
- **Model**: `ai4bharat/indic-conformer-600m-multilingual` — a 600M-parameter Conformer ASR model
  (MIT-licensed) covering all 22 official Indian languages, explicitly including Tamil and
  Malayalam (confirmed via the model's own Hugging Face card — unlike the earlier `IndicWav2Vec`
  models, which were only confirmed for Hindi/Odia/Bengali/Telugu). Loaded via
  `transformers.AutoModel.from_pretrained(..., trust_remote_code=True)`, per the model card's own
  documented usage example.
- **REPLACES Sarvam** for the languages it covers (`lib/transcribe.js`'s provider order:
  `WHISPER_LOCAL_ENABLED` → `AI4BHARAT_ENABLED` (for its ~10 supported languages) → Sarvam →
  OpenAI Whisper) — it targets the exact same problem (Indic-language accuracy) and, since it's a
  single whole-clip call with no 30-second-per-request cap to chunk around, has no equivalent to
  the chunk-boundary offset arithmetic that's the leading suspect in Sarvam's duplicated/misplaced
  -word bug.
- **Real, honest cost — heavier than faster-whisper, not as broken as whisperX.** Measured in
  testing: `transformers`+`torch`+`torchaudio` together are ~1.2GB even with the CPU-only torch
  wheel (`--index-url .../whl/cpu` in the Dockerfile is load-bearing — the DEFAULT `pip install
  torch` pulled in the full CUDA toolkit, 5GB+ of `nvidia-*` packages a CPU-only host would never
  use; confirmed directly in testing, not assumed). Meaningfully heavier than faster-whisper's
  ~150-200MB, but installs cleanly (unlike whisperX/NeMo) and doesn't need a GPU to run.
- **The one real gap: no word-level timestamps.** This model's documented interface
  (`model(wav, lang, "ctc")`) returns plain text only — no confirmed timestamp API exists in its
  model card or GitHub repo. So AI4Bharat genuinely improves the RECOGNIZED TEXT for Tamil/
  Malayalam/other Indic languages, but word timing still falls back to the same evenly-split-
  across-duration approximation this app already uses elsewhere as a fallback (flagged
  `approximate:true`) — not a false claim of per-word precision. If exact word timing matters more
  than recognition accuracy for a given project, `WHISPER_LOCAL_ENABLED` (faster-whisper, above)
  is the one with real word-level timestamps.
- **What's verified vs. not**: the model's documented usage pattern (load, resample to 16kHz mono
  via torchaudio, call with a language code) is confirmed against the model's own Hugging Face
  card. The dependency install and its real measured size were confirmed directly in testing.
  **Not verified**: actual model download + inference (this dev sandbox's proxy blocks
  huggingface.co, same limitation as the faster-whisper path above) — test against a real Tamil or
  Malayalam video after deploying.

### Fixed: models now pre-downloaded at build time, not on first use
Real production failure, not hypothetical: the first live transcription with either
`WHISPER_LOCAL_ENABLED` or `AI4BHARAT_ENABLED` turned on hit a bare `HTTP 502` — the model's
network-dependent first-download took longer than Coolify's reverse-proxy timeout (typically
60-120s), which killed the connection well before the code's own 20-minute wait would have. Fixed
by pre-downloading both models AT BUILD TIME (`Dockerfile`, `python3 -c "...WhisperModel(...)"`
/ `...AutoModel.from_pretrained(...)"`), same pattern the RVM/Remotion models already used —
whichever feature you enable, its model is already sitting in the image before the container ever
serves a request, so there's no cold-start download to time out on. Cost: a larger, slower image
build (unavoidable — the weights have to come from somewhere). One edge case worth knowing:
`WHISPER_MODEL_SIZE` changed at runtime without a matching `--build-arg WHISPER_MODEL_SIZE=<size>`
at build time still triggers one lazy (and possibly timeout-prone) download for that new size —
keep the two in sync, or expect that one extra rebuild.

### Fixed: AI4Bharat's model repo is gated — needs `HF_TOKEN`
Second real deploy failure, surfaced immediately by the build-time pre-download above instead of
as another vague runtime 502 — exactly what that change was for.
`ai4bharat/indic-conformer-600m-multilingual` turned out to be a **gated** Hugging Face repo (a
`401 GatedRepoError` on the build-time download attempt) — not documented anywhere findable before
hitting it for real. Downloading it needs: (1) a free Hugging Face account, (2) visiting
[the model's page](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual) and
clicking "Agree and access repository", (3) a read-scoped access token (Settings > Access Tokens),
passed to the Docker build as the `HF_TOKEN` build arg (Coolify: add `HF_TOKEN` as a build-time
variable on the render-pipeline resource — **not** a runtime env var, since the model downloads at
build time now, not per-request). The Dockerfile's AI4Bharat pre-download step is conditional on
`HF_TOKEN` being set — a missing token skips that one step (with a clear build-log message)
instead of failing the entire build for anyone who never intended to enable `AI4BHARAT_ENABLED` in
the first place. Set `AI4BHARAT_ENABLED` without `HF_TOKEN` and the feature will still fail, just
at runtime with the same real `GatedRepoError` message rather than a bare 502 — so set both
together.

### What's honestly not built here
Per-segment speed *ramping* (as opposed to one clip-wide speed), a chroma-key background *image*
(as opposed to a solid color), automatic voiceover dubbing/time-alignment into the render, and a
true tempo/BPM beat-tracker (as opposed to onset/energy-peak detection) are all real, identified
gaps versus a full CapCut feature set — each documented at its own section above rather than
silently shipped as if complete.

## Marketing Studio module — Text Behind Subject (beta)
A render option (`spec.text_behind_subject`, a "🫥 Text behind subject (beta)" chip in the
Editor's Auto-edit step) where captions sit behind the person on screen instead of on top —
implemented in `render-pipeline/` (`lib/segmentation.js` + `lib/textBehindSubject.js`), **not**
anything the Worker does itself. Runs local, free ONNX person-video-matting
([RobustVideoMatting](https://github.com/PeterL1n/RobustVideoMatting)) — no per-video API cost,
approximate edge quality (reduced processing resolution/frame-rate for CPU speed) — as opposed to
a paid cloud matting API, which would give cleaner results at a per-render cost. See
`render-pipeline/README.md`'s "Text behind subject (beta)" section for the full detail, including
exactly what was and wasn't verified (no real human test footage was available while building
this — only the ONNX inference plumbing and the compositing mechanics were confirmed working, not
real-world segmentation accuracy). **Doesn't combine with silence-cut/auto-zoom/B-roll/SFX/VFX
cues in the same render** — enforced in `render-pipeline/lib/render.js`, not just documented.

## Marketing Studio module — Multi-clip projects & template library

### Multi-clip projects (`migrations/0018_marketing_multiclip.sql`)
A project can now hold several uploaded clips, stitched into one combined video before the
existing transcribe/caption/render pipeline runs unchanged.
- **`marketing_project_clips`** — one row per clip (`project_id`, `source_key`,
  `source_duration_sec`, `order_index`). The very first upload
  (`POST /marketing/projects/upload-finish`) is now *also* registered here as `order_index=0` (in
  addition to setting the project's own `source_key` directly, unchanged) — so a project that
  only ever gets one video behaves exactly as before, while one that later adds more clips has a
  complete, correctly-ordered list to combine.
- `GET/POST/DELETE /marketing/projects/clips`, `PATCH /marketing/projects/clips/reorder` — clip
  CRUD, all session-gated and ownership-checked like every other route in this module.
- `POST /marketing/projects/combine-clips` — fetches all clips in `order_index` order, calls
  render-pipeline's `POST /concat-clips` (HMAC-signed like `/render`/`/extract-audio`, same
  `MARKETING_RENDER_WEBHOOK_SECRET`) with their public media URLs, and on success replaces the
  project's `source_key`/`source_duration_sec` with the combined result — from then on it's an
  ordinary single-video project. Requires the render pipeline configured (clip stitching needs
  ffmpeg); requires R2 storage specifically (the `LOCAL_PUBLIC_BASE_URL` local-fallback mode isn't
  supported for this one route, since the combined video needs a real `source_key` the rest of the
  app can address, not just a URL).
- **render-pipeline**: `POST /concat-clips` (`lib/concatClips.js`) — downloads each clip,
  normalizes every one to the target resolution (clips can come from different
  cameras/apps/resolutions/codecs — normalizing first, then using the `concat` *filter*
  rather than the stream-copy `concat` *demuxer*, is what makes mismatched inputs work at all),
  concatenates, uploads to R2. Verified with two clips of genuinely different resolutions
  (640×480 and 1080×1920) producing one correctly-normalized combined output.
- Frontend: a "Clips" card in the Editor (visible once a project has a video) — add more clips,
  reorder with ↑/↓, remove, and "🔗 Combine into one video" once there's more than one. Re-run
  Transcribe after combining — captions/cues from before a combine describe the old (shorter)
  video, not the new combined one, and aren't auto-migrated.

### Template library (`MARKETING_TEMPLATE_LIBRARY`, worker.js)
"Create a template library like Captions.ai" — 9 curated starter templates (Flash Sale, Product
Launch, Testimonial Quote, Countdown/Urgency, Before & After, Welcome/Business Intro,
Call-to-Action/Contact, Weekly Tip, Square Feed Promo), static config (same zero-cost shape as
`MARKETING_STYLE_PRESETS`/`MARKETING_AUTOEDIT_PRESETS` — no seed data in D1). `GET
/marketing/template-library` lists them; `POST /marketing/template-library/clone` copies one into
a real, client-owned, fully-editable `marketing_templates` row (`handleMarketingTemplateCreate`'s
same underlying table) — cloning, not referencing, so editing your copy never touches the shared
library list. Frontend: "📚 Browse Library" button on the Video Templates tab opens a card grid;
clicking a card clones it and opens the normal template editing flow.

### Animated template library — Remotion engine (`migrations/0019_marketing_remotion.sql`)
"Remotion for the template/style layer (React components map naturally to your existing
Cloudflare Workers setup) + FFmpeg/libass for the raw caption burn-in and Whisper for
transcription" — a second, real animation engine for Video Templates, alongside (not replacing)
the static-scene ffmpeg engine described above. The caption-burn-in pipeline for uploaded videos
and transcription are unchanged by this — Remotion is scoped specifically to the template/style
layer.

- **`marketing_templates.engine`** (`'ffmpeg'` default | `'remotion'`), **`.remotion_composition_id`**,
  **`.props_schema_json`** — new columns, migration `0019_marketing_remotion.sql`. A Remotion
  template has `scenes_json` empty/unused; a Remotion template's "scenes" are its React component
  (see render-pipeline's `remotion/` tree) and it renders via `spec.engine:'remotion'` instead of
  the default ffmpeg scene compositor.
- **`MARKETING_REMOTION_LIBRARY`** (worker.js) — 4 curated animated starter templates (Flash Sale,
  Product Launch, Countdown/Urgency, Testimonial Quote), each with a `props_schema` (key/label/
  default hints for the generate form) instead of `{{variable}}` scenes. Ids/props must stay in
  sync with render-pipeline's `remotion/Root.jsx` registry — this constant is metadata for the
  picker UI and prop hints only; the actual composition code lives in the render pipeline.
  `GET /marketing/remotion-library` lists them; `POST /marketing/remotion-library/clone` clones one
  into a client-owned `marketing_templates` row with `engine:'remotion'` set (same clone-not-
  reference pattern as the ffmpeg template library).
- **`handleMarketingTemplateGenerate`** branches on `template.engine`: for `'remotion'` it skips
  `marketingResolveScenes`/style resolution entirely and instead passes the batch row's variables
  straight through as `spec.props` (Remotion components consume props natively, no `{{variable}}`
  string substitution needed); for `'ffmpeg'` it behaves exactly as before. Either way the result
  is a normal `marketing_projects` row going through the same render-job/download/WhatsApp-send
  flow.
- **render-pipeline**: `spec.mode:'template', spec.engine:'remotion'` jobs are dispatched to
  `lib/remotionRender.js` (`server.js`'s `processJob`) instead of `lib/templateRender.js` — bundles
  the `remotion/` component tree once per process (webpack, cached, not redone per render),
  `selectComposition()`s the requested id with the job's props, `renderMedia()`s it via real
  headless Chrome at the project's target resolution, optionally burns in the watermark with a
  plain ffmpeg `drawtext` pass, uploads to R2. Requires a Chrome-capable container — see the
  `Dockerfile`'s new headless-Chrome runtime dependencies and its build-time
  `npx remotion browser ensure` step (downloads Chrome Headless Shell once at image build instead
  of on the first production render). See `render-pipeline/README.md`'s "Animated templates
  (Remotion engine)" section for the full technical writeup, including what was and wasn't
  verified (real bundle→render tests with visual frame confirmation; the actual Docker build step
  was not runnable in the dev sandbox — no Docker daemon there).
- Frontend: a "🎬 Browse Animated Templates" button next to "📚 Browse Library" on the Video
  Templates tab, opening the same clone-a-card flow; cloned/animated templates show an "🎬
  Animated" badge and a prop count instead of a scene count in the templates list, and the
  generate-batch panel prefills a sample row from the template's `props_schema` so it's clear
  which keys to use.
- **Manual step after deploying this**: run `wrangler d1 migrations apply leadvyne-d1 --remote`
  again (adds migration `0019`) and redeploy the render pipeline with the updated `Dockerfile` —
  the Chrome dependencies and `remotion browser ensure` step meaningfully increase build time/image
  size, so expect a slower build than previous render-pipeline deploys.

### Export quality control ("export as MP4 and control quality")
Output was always MP4 already (the only format this pipeline produces) — what was missing was
control over the encode speed/quality tradeoff, previously hardcoded (`crf 21`, `preset veryfast`)
everywhere. `MARKETING_QUALITY_LEVELS = ['draft','standard','high']` (worker.js) validates
`options.quality` into `spec.quality`; `QUALITY_PRESETS` (`render-pipeline/lib/filtergraph.js`,
exported and reused by `templateRender.js`/`textBehindSubject.js` so all three render modes stay
consistent) maps it to actual ffmpeg `-crf`/`-preset` values: `draft` (28/ultrafast, fastest,
for quick previews), `standard` (21/veryfast, the previous default, unchanged for anyone not
picking a quality), `high` (17/medium, visibly cleaner, noticeably slower encode). Frontend: a
quality `<select>` in the Editor's Render & export step.

### Auto-suggested B-Roll/SFX/VFX cues
Previously required a manual "✨ Suggest cues" click after transcribing. `transcribeProject()`
(`marketing-studio.html`) now calls `suggestCues()` automatically right after a successful
transcription — still free (the same zero-cost keyword heuristic, no LLM call), and the button
stays available to re-run it. Suggested cues already defaulted to `accepted:true`
(`marketingSuggestCuesHeuristic`), so this closes the remaining manual step without changing what
actually ends up in a render — cues were never excluded by default, only *surfaced* on request.

### Modern UX pass (`marketing-studio.html`)
- **Toast notifications** replace `alert()` for every non-destructive message (errors,
  confirmations) — `confirm()` is kept for actual deletions, which should still interrupt.
- **Drag-and-drop upload** with a real progress bar — the upload now goes through `XMLHttpRequest`
  instead of `fetch()` specifically because `fetch` has no upload-progress event to hook.
- **Inline, click-to-edit captions** replace a blocking `prompt()` dialog — click a word, type the
  fix in place (a real `contenteditable` span, not a modal), Enter or click-away commits it.

### CapCut-style editor layout — interactive timeline + tabbed tool panel
Replaces the old always-stacked "5 numbered step cards" layout and the old read-only percentage-
positioned timeline strip. Purely a frontend interaction layer on top of data that already
existed — **no new backend endpoints**; every drag ends by calling the same `saveTrim()`/
`autoSaveCues()` functions the old manual controls already used.
- **Interactive timeline** (`#ccTimeline`, `renderTimeline()`/`setupTimelineDragHandlers()`) —
  pixel-per-second positioned (a `timelineZoom` slider controls `ccPxPerSec`), horizontally
  scrollable, with a fixed non-scrolling label gutter (`.cc-timeline-labels`) so track labels don't
  get clipped by the scrolling area. Five tracks: **Trim** (draggable region + two resize handles,
  writes to the same `#trimStart`/`#trimEnd` inputs "Save trim & aspect" always used), **Scenes**
  (read-only, click to jump — from `detectScenes()`), and **B-Roll/SFX/VFX** (one track per cue
  type, each cue block draggable to reposition and right-edge-resizable to change duration,
  writing straight into `currentCues[i].start/end`). Clicking anywhere else on the timeline scrubs
  the actual `<video id="previewVideo">` via `currentTime`; playback moves a live playhead via the
  video's own `timeupdate` event.
- **Tabbed tool panel** (`#ccTabs`, `showEditorTab()`) — the old 5 stacked cards (Captions/Style/
  Auto-Edit/Cues/Export) are now one-at-a-time panels switched by tab, with a small status dot per
  tab (done/active/pending) replacing the old separate "Steps" rail card. `scrollToStep(n)` is kept
  as a thin numeric-to-tab-name wrapper since a few other places (e.g. clicking a cue on the old
  timeline) called it by step number.
- **NOT built**: thumbnail filmstrips or an audio waveform on the timeline (would need new backend
  support — frame extraction / waveform generation — not just a frontend change), and multi-track
  compositing beyond what already existed (this is still one video source with cue overlays, not a
  layered multi-clip timeline).

## Marketing Studio module — Content Calendar & Instagram Auto-Posting (`frontend/marketing-studio.html` — "🗓️ Content Calendar" tab, `cloudflare-worker/worker.js`, `cloudflare-worker/migrations/0038_marketing_content_studio.sql`)
Plan Instagram posts (title + caption, scheduled to a date) ahead of time, on the same D1-not-
NocoDB `marketing_content_posts` table the rest of this module uses. This is the **planning layer
only** — the table already has `image_key`/`approved_at`/`ig_media_id` columns reserved for two
later increments that build on top of it without a schema change: AI image generation/editing via
fal.ai (Image Studio), and the actual approval-gated auto-publish to Instagram (reusing the
Instagram DM module's `ig_id`/`ig_access_token` connection, whose OAuth scope already requests
`instagram_business_content_publish` — see that module's own comment for the reconnect caveat on
accounts connected before this scope existed).

### CRUD (`handleContentPost{List,Create,Update,Delete}` in worker.js)
Standard per-client CRUD on `marketing_content_posts`. A post with `scheduled_at` set gets
`status='scheduled'`; without it, `status='draft'`. Editing/deleting a `status='posted'` post is
rejected — once a post has actually gone out, this module treats it as immutable history.

### Google Calendar sync (`marketingContentSyncGcal`)
Reuses the **existing** Google Calendar connection (`gcal_refresh_token`/`gcal_calendar_id` on the
Clients table — see "Google Calendar Sync" above) rather than a second OAuth flow: scheduling a
post upserts an event titled `📲 <title>` on the same "Leadvyne Tasks & Events" calendar a rep
already has, and clearing/deleting the post's schedule removes it. Best-effort and silent if the
client never connected Google Calendar (same as every other caller of `gcalUpsertEvent`). Like
that sync itself, this is **one-way** (Leadvyne → Google) — editing the event's date directly in
Google Calendar does not reschedule the post here.

### "Generate a week" (`handleContentGenerateWeek`, `POST /marketing/content/generate-week`)
One topic fans out into N (1-14, default 7) daily draft post ideas in a single call — a cheap way
to fill the calendar before spending anything on images. Reuses the **same shared-key, JSON-mode
Gemini call** `handleMarketingSuggestCaption` already uses for video captions (`engineGeminiGenerate`,
`env.GEMINI_API_KEY` — no client-supplied key, unlike fal.ai), asking for `{"posts":[{title,
caption, hashtags}, ...]}` with exactly N items. Falls back to a plain templated caption per day if
`GEMINI_API_KEY` isn't configured or the model doesn't return valid JSON — same
graceful-degrade-not-hard-fail shape as the caption suggester. Every generated post lands as a
**draft with no image** (`image_key` stays NULL) — deliberately so a week of ideas costs one text
call, not N fal.ai image generations up front; an image only gets generated once a specific post is
individually approved (the later Image Studio/auto-post increment).

### "Turn a customer into a post" (`handleContentFromCustomer`, `GET /marketing/content/customers` + `POST /marketing/content/from-customer`)
Sources a testimonial/case-study draft straight from a closed deal instead of a free-text topic —
the picker (`GET /marketing/content/customers`) lists Leads rows whose `Stage` is `won` or
`converted`, the same literal values Human Deals' one-click "✅ Won" button writes
(`HD_OUTCOME_STAGE` in `dashboard.html`), filtered to this client and sorted by `ClosedAt` desc.
Picking one calls the same `engineGeminiGenerate` shared-key path as "Generate a week" with the
deal's own facts (`InterestedProduct`, `DealValue`, `ClosedAt`) as input, and lands as a **draft
with no image**, same as every other generator in this module.
- **Anonymized by default**: the prompt explicitly forbids the model from including the customer's
  real name, phone, or any other identifying detail in the generated caption — it refers to them
  generically ("a local business", "one of our clients"). The lead's real name is only ever used in
  the draft's internal `title` (never shown to followers, purely so a marketer can tell drafts
  apart in the calendar list) — this endpoint has no way to know a customer consented to being
  named publicly, so it never assumes it. A marketer who *does* have consent can still type the
  name into the caption by hand afterward via the normal Edit flow.

## Marketing Studio module — Image Studio (`frontend/marketing-studio.html` — "🖼️ Image Studio" tab, `cloudflare-worker/worker.js`, `render-pipeline/lib/imageCompose.js` + `render-pipeline/server.js`, `cloudflare-worker/migrations/0039_marketing_image_studio.sql`)
Generates and edits post images for the Content Calendar. Deliberately split across two different
execution paths depending on whether the operation genuinely needs an ML model:

### Generative (fal.ai, paid, client-supplied key only — same policy as AI B-roll)
- **Generate** (`handleMarketingImageGenerate`, `POST /marketing/images/generate`) — text-to-image
  (`fal-ai/flux/dev`), with an aspect-ratio picker matching real Instagram formats (1:1/4:5 feed,
  9:16 story/reel, 16:9 landscape) and up to 4 variations returned from a single call so a marketer
  picks a favorite instead of regenerating one at a time. Curated starter prompts
  (`MARKETING_IMAGE_PROMPT_TEMPLATES`, `GET /marketing/images/prompt-templates`) cost nothing —
  static text, just pre-fills the prompt box for someone who doesn't know how to write one.
- **Generate for post** (`handleMarketingImageGenerateForPost`, `POST /marketing/images/generate-for-post`)
  — same generation path, but the prompt is seeded from a Content Calendar draft's own
  title/caption instead of asking the marketer to describe the image separately — the "🖼️ Generate
  image" button on each calendar card. Returns candidates only; nothing auto-attaches to the post.
- **Restyle** (`handleMarketingImageRestyle`, `POST /marketing/images/restyle`) — image-to-image
  (`fal-ai/flux-pro/kontext`) on an existing image or a freshly-uploaded real photo
  (`POST /marketing/images/upload`) — "turn this actual shop/product photo into a polished graphic."
- **Remove background** (`handleMarketingImageRemoveBackground`, `POST /marketing/images/remove-background`)
  — `fal-ai/imageutils/rembg`. Pairs with the deterministic composite step below.

### Deterministic (ffmpeg via the render pipeline, no fal cost, no AI unpredictability)
A still image is a one-frame video as far as ffmpeg is concerned, so three operations that don't
need an ML model at all reuse the SAME ffmpeg binary this pipeline already runs for video —
`render-pipeline/lib/imageCompose.js`, called via a new synchronous route (same
HMAC-signed-request, bounded-single-pass shape as `/detect-scenes`/`/concat-clips`):
`POST /image-compose` with `{mode, client_id, ...}`.
- **`watermark`** (`handleMarketingImageWatermark`, `POST /marketing/images/watermark`) — overlays
  the client's brand logo (`marketing_client_settings.logo_key`, uploaded via
  `POST /marketing/logo`) at a fixed corner, scaled to a % of the base image's width. Pixel-exact
  and free, unlike asking a diffusion image-edit model to "add the logo" (unreliable placement,
  costs a paid call) — fal.ai is reserved for edits that genuinely need semantic understanding.
- **`composite-background`** (`handleMarketingImageCompositeBackground`, `POST /marketing/images/composite-background`)
  — drops a (typically transparent) cutout onto a solid brand-color backdrop sized to match it. The
  actual subject/background *separation* is still fal's `remove-background` above (a genuine ML
  task); this is just the deterministic "now put it on a flat color" half.
- **`text-overlay`** (`handleMarketingImageTextOverlay`, `POST /marketing/images/text-overlay`) —
  burns in a headline/subtext via ffmpeg's `drawtext` filter (text written to a temp file and
  referenced via `textfile=`, sidestepping filtergraph string-escaping entirely). Exists because
  diffusion models are notoriously unreliable at rendering legible in-image text — for a "SALE 20%
  OFF" style graphic, this is more reliable than asking fal to draw it, and it's free.

`output_key` from the render pipeline (R2-backed) is already a key in the SAME `MARKETING_MEDIA`
bucket the Worker serves from (see `render-pipeline/lib/storage.js`'s own comment) so it's used
directly; `output_url` (local-fallback render pipeline, no R2 there) is re-fetched into that bucket
via `marketingStoreExternalImage` so every image in this module is addressed the same way — an R2
key — regardless of which path produced it.

### Usage counter & ownership
`marketing_image_log` (one row per successful operation, any kind) backs a simple "N images
generated this month" pill (`GET /marketing/images/usage`) — fal.ai bills the client's own key, so
this is a lightweight spend-awareness signal, not a hard cap. Image keys are random UUIDs under
`marketing/<client>/images/` (or `marketing/<client>/logo.*` for the logo) — not reconstructible
from client input, so ownership on every operation that takes an existing `image_key` is a prefix
match against the caller's own namespace (`marketingImageKeyOwnedBy`), same reasoning as the
multi-clip upload-finish check earlier in this file.

**NOT verified against a live fal.ai key or a live render-pipeline deploy in this sandbox** — same
caveat as AI B-roll (`falBroll.js`)'s own comment: model ids/result-field names are fal's
documented shapes as of this writing, and every failure path surfaces the raw upstream response so
a wrong field name is a one-line fix once tested against real credentials.

### Image Studio extras (`cloudflare-worker/migrations/0040_marketing_image_studio_extras.sql`)
Seven small additions on top of the base Image Studio, each reusing something already in this
module rather than new infrastructure:
- **Brand style profile** (`image_brand_style` column, `GET`/`POST /marketing/images/brand-style`)
  — a saved text hint (e.g. "warm earthy tones, minimalist") appended to every generate/
  generate-for-post/carousel prompt automatically, same idea as the video module's Brand Styles.
- **Draft vs final quality** (`quality:'draft'|'final'` on generate/generate-for-post/carousel) —
  `'draft'` uses `fal-ai/flux/schnell` (the distilled/turbo variant — faster and cheaper) so ideas
  can be explored before committing to `'final'`'s `fal-ai/flux/dev` quality.
- **Prompt-hash caching** (`marketing_image_log.prompt_hash`, `marketingImageCacheLookup`) — an
  identical generate call (same client + prompt + aspect + quality) within the last 24h reuses the
  earlier result instead of spending fresh fal.ai credits; most useful for an accidental
  double-click or re-running the same "Generate a week" topic same-day.
- **Multi-aspect reframe** (`handleMarketingImageReframe`, `POST /marketing/images/reframe`,
  `reframeToAspect` in `imageCompose.js`) — a center crop to a different platform aspect (feed ↔
  story/reel ↔ landscape) via the SAME deterministic ffmpeg delegation as watermark/
  composite-background/text-overlay, so getting a second shape of an approved image doesn't cost a
  second fal.ai generation.
- **"Generate a themed set"** (`handleMarketingImageGenerateCarousel`, `POST /marketing/images/generate-carousel`)
  — 2-4 images nudged toward distinct roles in a short sequence (intro/detail/detail/CTA) instead
  of unrelated takes on the same prompt. Deliberately **generation only**: `marketing_content_posts`
  has a single `image_key` column and this app has no Instagram publish step at all yet, so there's
  nowhere to wire an actual multi-image carousel POST to — building that now would mean guessing at
  a schema/publish shape ahead of the real auto-post feature existing. What a marketer gets today is
  a coherent set to pick one favorite from via the normal `/marketing/images/attach` flow.
- **Free stock-photo fallback** (`handleMarketingImageStockSearch`/`handleMarketingImageStockImport`,
  `GET /marketing/images/stock-search`, `POST /marketing/images/stock-import`) — searches Pexels'
  and Pixabay's PHOTO endpoints (distinct from the video-B-roll endpoints those same keys already
  power in `render-pipeline/lib/assets.js`) using the client's existing free API keys, and imports
  the chosen photo into this client's own R2 namespace so it behaves exactly like a generated image
  afterward. Makes Image Studio usable without ever adding a paid fal.ai key.
- **Usage counter now excludes free operations** — `MARKETING_IMAGE_PAID_KINDS` restricts the
  "images generated this month" pill to `generate`/`restyle`/`remove-background` (the fal.ai-billed
  kinds); watermark/composite-background/text-overlay/reframe/stock-import are free and would have
  made that "money spent" signal misleadingly high if counted the same way.

Frontend-only, no backend change: an **"Always watermark before attach"** checkbox
(`localStorage`, not server-side — purely a per-browser convenience toggle) auto-runs the watermark
step right before attaching if a logo is set and the current image isn't already watermarked; and a
client-side-only **workspace history breadcrumb** (`workspaceHistorySteps`) shows what's been
applied so far to the current image (Generated → Restyled → Watermarked → …), giving the existing
"restyle again on the current image" flow (already fully iterative — each restyle already operates
on whatever the workspace currently holds) a visible, chat-like trail instead of just a silently
updating preview.

## Financial Planning module (`frontend/accounting.html` — "💰 Financial Planning" tab, `cloudflare-worker/worker.js`, `cloudflare-worker/migrations/0015_financial_planning.sql`)

Recurring-revenue and expense tracking for a client's own downstream customers — genuinely new to
this app: there was no D1-backed Customer entity, no billing-cycle/due-date concept, no monthly
cron, and no payment-gateway integration anywhere before this. **Native in D1 + Workers** (the
architecture explicitly chosen for this feature), same reasoning as every other D1 module here —
this data shape (billing cycles, aging, monthly generation) has no NocoDB reader and doesn't need
one.

Deliberately **separate from the existing "👤 Customers" tab**, which is a live ERPNext passthrough
with no local storage at all. `fp_customers` is this app's own recurring-billing customer record,
independent of whether ERPNext is even connected — a customer here can optionally link back to a
CRM lead via `lead_id` (a plain integer reference, not a SQL foreign key, same convention as
`accounting_documents.linked_doc_id` — it must still resolve even if the originating lead is later
deleted/merged).

### Schema (migration 0015)
- **`fp_customers`** — name, plan/service, `monthly_value`, `currency`, `billing_cycle`
  (monthly/quarterly/yearly), `billing_day` (clamped 1–28 so a due date is always a valid calendar
  date), `start_date`, `status` (active/paused/cancelled).
- **`fp_expected_dues`** — one row per (customer, billing period `YYYY-MM`), auto-generated by the
  monthly cron below. `UNIQUE(customer_id, period_key)` makes re-generation idempotent — a
  redelivered cron tick just hits the constraint and no-ops. `collected_amount`/`status`
  (open/partial/paid/void) are denormalized, recomputed by `fpRecomputeDueStatus` after every linked
  collection create/delete rather than joined on every read — same "precomputed total" convention as
  `accounting_documents.total`.
- **`fp_collections`** — an actual payment, either against a specific due (`expected_due_id` set) or
  ad-hoc/advance (`expected_due_id` NULL). `razorpay_payment_id` is only ever set by the Razorpay
  webhook; its own unique index means a redelivered webhook for the same payment is recognized and
  ignored instead of double-counted.
- **`fp_expense_templates`** — Fixed Recurring expense definitions (rent, salaries, SaaS tools),
  auto-booked into `fp_expenses` on the 1st of each month while `active`.
- **`fp_expenses`** — every expense, `type` fixed|onetime. Fixed rows carry `template_id`+
  `period_key`, deduped by a partial unique index (`WHERE template_id IS NOT NULL`) so a re-run
  never double-books the same template in the same month. One-time expenses are inserted directly
  with `template_id` NULL and a category tag (marketing/infra/travel/etc.).
- **`fp_config`** — per-client opt-in gate (`enabled`, `reminders_enabled`) plus Razorpay credentials
  (`razorpay_key_id`/`razorpay_key_secret`/`razorpay_webhook_secret`, plaintext-on-a-dedicated-table,
  same convention as `erpnext_api_key`/`erpnext_api_secret` on CLIENTS — no secrets vault anywhere in
  this codebase). Only clients who've ever created Financial Planning data get a row here, so the
  monthly cron and reminder sweep scan this table instead of a full CLIENTS pass.

### Lead conversion → customer (fire-and-forget)
`markLeadWon`/`markHumanDealWon` (`frontend/dashboard.html`) already push a won deal into ERPNext
customers best-effort; the same "✅ Won" click now also fires `POST /financial/customers/ensure`
(`{lead_id, name, phone, email}`), wrapped in `.catch(()=>{})` so it can never block or fail the
outcome. `handleFpCustomerEnsure` search-or-creates by `lead_id`, so re-clicking Won or any later
resync is a no-op rather than a duplicate customer. The created record starts at `monthly_value: 0`
— someone still has to set the actual plan/value from the Financial Planning → Customers tab (the
"prompt to create customer + set expected monthly value" workflow is this manual follow-up step,
not a modal that pops on conversion).

### Monthly generation cron
Piggybacks on the existing daily `0 2 * * *` Worker tick (`runFinancialPlanningMonthlyForAllClients`)
rather than adding a 4th distinct cron string to `scheduled()`'s dispatch chain — that function
self-gates internally on `new Date().getUTCDate()===1` and no-ops on every other day. For each
client in `fp_config WHERE enabled=1`, `fpGenerateForClient`:
- Generates an `fp_expected_dues` row for every `active` customer whose cycle applies this month
  (monthly: every month; quarterly: Jan/Apr/Jul/Oct; yearly: only the customer's own start month).
- Auto-books an `fp_expenses` row (`type:'fixed'`) for every active `fp_expense_templates` row.

Both inserts rely on their table's unique index to make re-running the same period a harmless no-op
— errors are caught per-client so one client's failure never aborts the sweep for the rest.

### Overdue reminders
`runFinancialPlanningRemindersForAllClients` runs on the same daily tick, scanning
`fp_config WHERE enabled=1 AND reminders_enabled=1`. For each client, `fpSendRemindersForClient`
finds dues that are `open`/`partial`, past `due_date`, have an actual positive balance owed
(`amount - collected_amount > 0` — a due worth `0.00` is seeded/recomputed straight to `paid` and
never enters this query at all, see below), and either never reminded or last reminded 3+ days ago
(`reminder_sent_at`) — the same flag-flip idempotency as the Shopify abandoned-cart sweep's
`nudge_sent`, just re-armed after a cooldown instead of one-shot.

Since this sweep only ever fires off the daily cron — never inside a customer-initiated 24-hour
WhatsApp session window — a plain-text Chatwoot send is not viable outside that window; only an
approved WhatsApp template is. `fp_config.reminder_template_name` (+ `reminder_template_category`/
`reminder_template_language`, Financial Planning → Settings) must be assigned before this sweep
sends anything at all: with no template configured, `fpSendRemindersForClient` skips the entire
client (logs `skipped_no_template`) rather than repeatedly attempting sends WhatsApp will reject.
Once assigned, each due's AI-drafted (or fallback fixed-text) reminder is sent as the sole `{{1}}`
variable of that template. Resolves each due's linked lead's Chatwoot conversation, pacing sends
300ms apart in a sequential loop (same spirit as `recovery.js`'s `SEND_DELAY_MS`) with a per-item
try/catch so one failure can't kill the sweep. Skips entirely if the client has no Chatwoot
connection; skips a given due if it has no linked lead or no resolvable conversation.

Every attempt — sent, failed, or skipped (and why) — is written to `fp_reminder_log`
(`client_id, due_id, status, detail, created_at`, migration `0041_fp_reminder_tracking.sql`) via
`fpLogReminderAttempt`, replacing the previous silent `catch(e){}` that left no trace of a failed
send. `GET /financial/reminder-log` (session-scoped, last 100 rows) backs the "Reminder Log" table
on the Settings tab.

A zero-value due (customer left at `monthly_value: 0`, see "Lead conversion → customer" above) is
never actually owed anything, so it's excluded from ever going `open` in the first place:
`fpGenerateForClient` seeds it straight to `status:'paid'` when generated, and
`fpRecomputeDueStatus` now also settles `amount<=0` dues to `'paid'` unconditionally on any
collection recompute. Migration `0041` backfills any pre-existing `0.00` dues that were stuck
`open`/`partial` (and getting reminded on) before this fix.

### Collections — manual or Razorpay webhook
`POST /financial/collections` records a manual payment (bank/UPI/cash/other), full or partial,
against a due or ad-hoc. `POST /financial/razorpay-webhook/<clientId>` handles
`payment.captured`/`payment_link.paid` events: reads the raw body via `request.text()` *before* any
JSON parsing, verifies `X-Razorpay-Signature` as HMAC-SHA256 over that raw body using the client's
own `razorpay_webhook_secret` (constant-time compare, same pattern as the existing Stripe/Shopify
webhook verifiers), then extracts `fp_customer_id` (and optionally `fp_expected_due_id`) out of the
payment's `notes` — set these two fields on the Razorpay Payment Link / Order when creating it so
the webhook knows which customer to credit. Acks with `200`/`{ok:true}` on anything it can't use
(unconfigured client, bad JSON, wrong event type) rather than erroring, so Razorpay doesn't keep
retrying; a redelivered webhook for an already-recorded `razorpay_payment_id` returns
`{ok:true, duplicate:true}` instead of double-counting. The webhook URL to paste into Razorpay's
Dashboard → Settings → Webhooks is shown on the module's own Settings tab.

### Dashboard (`GET /financial/dashboard`)
Expected vs Collected for the current month (+ collection %), aging buckets (0-7/8-15/16-30/30+
days overdue, computed from `due_date` vs. today — a due not yet past its date shows no bucket),
Total Expenses split fixed vs. one-time, Net Position (Collected − Expenses), a 6-month trend
(Chart.js grouped bar, same library/CDN `dashboard.html` already uses for its own charts — guarded
with `typeof Chart==='undefined'` so a blocked/slow CDN degrades to just hiding the chart instead of
taking the whole page's `init()` down with it), and a sortable Outstanding Receivables list
(customer name / balance / most-overdue-first).

### Frontend (`frontend/accounting.html`)
A 4th top-level tab alongside Documents/Customers/ERPNext, with its own internal pill sub-nav
(Dashboard / Customers / Collections / Expenses / Settings) since the module has too many distinct
views for one flat page. Customer, Collection, Fixed-Expense-Template and One-time-Expense modals
follow this file's existing `.modal-overlay`/`.modal-card` convention. Settings never re-sends a
previously-saved Razorpay Key Secret back to the browser (`GET /financial/config` only returns
`razorpay_key_id`/`razorpay_webhook_secret`, matching the fact `razorpay_key_secret` is
write-only) — the frontend only includes a secret field in its `PATCH` body when the user actually
typed something into it, so re-saving the enabled/reminders toggles alone can never accidentally
wipe out a previously-configured secret.

### AI-Supported Bookkeeping (migration `0034_fp_ai_snapshot.sql`)
Layman-friendly, AI-powered features built entirely on the shared `env.GEMINI_API_KEY` the
WhatsApp engine already uses (`engineGeminiGenerate`/`engineGeminiTranscribeVoice` — no new
provider/credential to configure). All five routes live under `/financial/ai/*` in `worker.js`,
right after `fpGenerateForClient`:

- **Snap & Save / Type-it-in** (`POST /financial/ai/parse-expense`) — a photo of a receipt
  (`imageBase64`+`mimeType`) or a plain sentence (`text`) is parsed into a structured draft
  (`fpAiParseExpenseImage`/`fpAiParseExpenseText`, both normalized by
  `fpAiNormalizeParsedExpense` against a fixed `FP_EXPENSE_CATEGORIES` list). Never auto-saved —
  the frontend's `aiQuickAddFromPhoto`/`aiQuickAddFromText` (Expenses sub-tab) hand the parsed
  draft straight into the existing One-time Expense modal for the owner to review and save
  themselves.
- **Ask Your Books** (`POST /financial/ai/ask`) — `fpAiComputeSnapshotData` computes this
  client's real numbers (expected/collected this month, outstanding total, top expense
  categories, active customer count) server-side; the model is told to answer *only* from that
  JSON and never invent a number. The Dashboard sub-tab's "💬 Ask Your Books" card is a thin
  wrapper over this.
- **Monthly AI Snapshot** (`GET /financial/ai/snapshot`, `POST …/regenerate`) — a one-paragraph
  plain-English narrative (`fpAiGenerateSnapshotNarrative`), cached on
  `fp_config.ai_snapshot_text`/`ai_snapshot_period` per calendar month so it isn't regenerated on
  every dashboard load; the Regenerate button forces a fresh call.
- **Cash Flow Outlook** (`GET /financial/ai/forecast`) — `fpAiComputeForecastData` looks at open
  `fp_expected_dues` due before month end and active `fp_expense_templates` not yet booked this
  period, then narrates the outlook. Computed fresh every call (cheap dataset, no caching needed).
- **AI-drafted reminders** (`fpAiDraftReminder`) — replaces the fixed-template WhatsApp message
  `fpSendRemindersForClient`'s automatic overdue sweep sends, falling back to the old exact
  template (`fpDefaultReminderText`) if Gemini is unavailable. `POST /financial/ai/draft-reminder`
  exposes the same drafting for the Dashboard's "✨ Draft reminder" button (an on-demand preview
  the owner copies and sends themselves, not an automatic send).
- **Unusual-expense nudge** (`fpAiFlagUnusualExpenses`) — a plain average-vs-latest comparison per
  category, not an AI call (instant, free); wired into `handleFpExpensesList`'s response as
  `is_unusual`/`category_avg` on each row, needs 3+ prior one-time expenses in a category before it
  flags anything.
- **Tax set-aside estimate** — `fp_config.tax_reserve_pct` (Settings), a simple
  `net_position_this_month * pct` shown on the Dashboard only when positive; explicitly labeled an
  estimate, not tax/filing advice.

### Admin-number WhatsApp bookkeeping shortcut
`fp_config.admin_phone_numbers` (JSON array, Settings tab) lets the owner text their own books on
the exact same WhatsApp number/inbox the customer-facing lead-gen bot runs on, without the two ever
colliding: `handleEngineWebhook` checks `fpIsAdminPhone` (last-10-digits match, so
`+971501234567`/`00971501234567`/`0501234567` all resolve the same) immediately after resolving the
sender's phone — before any state load, intent classification, or `LEADS` upsert — and diverts a
match straight to `fpHandleAdminWhatsappMessage` instead. That handler supports text, a voice note
(transcribed via `engineGeminiTranscribeVoice`), or a receipt photo; a message that reads as a
question goes through the same Ask-Your-Books path, everything else is parsed and booked as an
expense immediately (being on the allow-list *is* the confirmation here — unlike the in-app Snap &
Save, there's no draft-review step) and confirmed back over WhatsApp via `engineSendChatwootReply`.

### Interconnection, Reports, and a single default currency (migration `0036_accounting_interconnect.sql`)
Ties Documents/Expense Entry/Vendor Bills into the same master data Financial Planning already
had, adds standard SMB reports, and a single account-wide currency default:

- **`fp_suppliers`** — the accounts-payable mirror of `fp_customers`, its own "🏭 Suppliers"
  sub-tab. `accounting_vendor_bills.supplier_id` and `accounting_expenses.supplier_id` are
  optional links to it; the Vendor Bill and Expense Entry modals resolve/create a supplier by
  typed name on save (`handleFpSupplierEnsure`/frontend `ensureFpSupplierByName`, same
  search-or-create idempotency as every other "ensure" route in this app), so a name typed once
  in either place exists in both.
- **`accounting_documents.customer_id`** — same idea for the sales side: the Document modal's
  Customer Name field (used when there's no CRM lead) resolves/creates an `fp_customers` record
  via `handleFpCustomerEnsureByName`/`ensureFpCustomerByName`, so a walk-in customer billed
  through Documents shows up in Financial Planning → Customers automatically.
- **`fp_config.default_currency`** — set once in Financial Planning → Settings, read by the
  frontend's `getDefaultCurrency()` as the shared starting value for every currency field across
  the whole module (Documents, Expense Entry, Vendor Bills, Financial Planning's own modals),
  replacing what used to be a different hardcoded fallback per modal (`'AED'` here, `'INR'`
  there). Every field stays freely editable — this only changes the default.
- **Unified Dashboard** — `handleFpDashboard` now folds Documents' unpaid invoices into "Money
  Owed to You" alongside recurring `fp_expected_dues`, adds a "Money You Owe" stat + table from
  unpaid `accounting_vendor_bills` (aged with the same `FP_AGING_BUCKETS` buckets as receivables),
  and combines `fp_expenses` with `accounting_expenses` into one Total Expenses figure and 6-month
  trend. `fpAiComputeSnapshotData` (Ask Your Books / the monthly AI snapshot) gets the same
  unification so the AI narrative describes the whole business.
- **Reports tab** (`frontend/accounting.html` "📊 Reports", `/financial/reports/*` in worker.js) —
  Profit & Loss (`handleFpReportPL`, income from actual `fp_collections`/Documents' Receipts
  within a date range vs. combined expenses), Accounts Receivable Aging
  (`handleFpReportArAging`, recurring dues + unpaid invoices in one aged list), Accounts Payable
  Aging (`handleFpReportApAging`, unpaid Vendor Bills), Expense Breakdown by category
  (`handleFpReportExpenseBreakdown`, trailing N months), and a Sales Summary
  (`handleFpReportSalesSummary`, Documents by type/status + quotation→accepted conversion rate).
  All computed on demand from existing tables — no separate ledger, no double-entry.

### Separate Quotation/Invoice windows, and paying an Invoice records income + a collection (migration `0037_accounting_doc_dates_and_paid.sql`)
Quotation and Invoice are two real windows in `accounting.html`, not one modal relabeled by
type — `DOC_TYPE_CFG` maps each type to its own DOM prefix (`docQuotation*`/`docInvoice*`) and the
shared line-item/lead-picker/cross-sell logic (`addDocLineItemRow`, `collectDocLineItems`,
`renderDocTypeCrossSell`, etc.) is parameterized by type rather than duplicated. A Quotation gets
an optional Valid Until date (`accounting_documents.valid_until`); an Invoice gets an optional Due
Date (`due_date`). Financial Planning → Customers rows get "🧾"/"📄" quick actions
(`newDocForFpCustomer`) that jump to the Documents tab and open the right window pre-filled for
that customer. `buildDocumentPdf` renders each type's PDF differently now too: the type-specific
date, a PAID/VOID stamp, "Amount Due"/"Amount Paid" vs. "Total" on the summary bar, and a
quotation-only "this is not a tax invoice" disclaimer.

Setting an Invoice's status to `paid` (the status dropdown on the Documents table) triggers
`fpRecordInvoicePaidSideEffects` from `handleAccountingDocumentUpdate`, which records the two
things "money actually came in" means elsewhere in this app:
- **Income** — an auto-created Receipt linked back via `linked_doc_id` (skipped if one already
  exists, e.g. from a manual Convert), the same shape `handleAccountingDocumentConvert` builds, so
  it's counted by P&L/Sales Summary exactly like any other Receipt.
- **Collection** — an `fp_collections` row (ad-hoc, no `expected_due_id`), so it shows in
  Financial Planning → Collections and counts toward the Dashboard's Collected total. Needs an
  `fp_customers` link: uses the invoice's own `customer_id` if set, else resolves one from its
  linked lead's Name/Phone or its plain `customer_name` via `fpEnsureCustomerByName` (the same
  core search-or-create both `handleFpCustomerEnsureByName` and the lead-`ensure` route share).

`accounting_documents.paid_recorded_at` guards this from running twice — flipping status away
from and back to `paid` (e.g. a correction) won't double-book either the Receipt or the
collection.

## SaaS Ops module (`frontend/saas-ops.html` — own top-level tab, `cloudflare-worker/worker.js`, `cloudflare-worker/migrations/0025_saas_ops.sql` + `0027_saas_nocodb_accounts.sql`)

Subscription/lifecycle tracking, activation, product usage/PQL signals, account health scoring,
support-ticket signals, CSM touchpoints, NPS/CSAT surveys, competitor battlecards, and renewal/
activation reminders for the **SaaS / Digital Marketing** industry (`INDUSTRIES.saas_digital_marketing`
in `frontend/dashboard.html`).

**v2 architecture (this section) — the client's own live NocoDB customers table is the account
system of record, not a D1 shadow table.** The module originally shipped built on top of the
Financial Planning module's `fp_customers` table (v1 — see git history / migration 0025's own
comments for that version's reasoning). The user running this app clarified explicitly that their
NocoDB customers table already holds their real, live SaaS customers, and that this module must not
conflate that with `fp_customers`/ERPNext. This section describes the current (v2) design:

- **Account = a row in the client's own NocoDB table**, pointed at via
  `saas_config.nocodb_customers_table_id` (a dedicated settings table, split out of Financial
  Planning's own `fp_config` — see Schema below). Every SaaS Ops read fetches the full row (all
  columns, schema-agnostic — same approach as the rest of this app's per-client dynamic-table
  integrations).
- **This app only ever WRITES to columns it created itself**, all prefixed `saas_`
  (`saas_lifecycle_stage`, `saas_health_score`, `saas_health_score_manual`, `saas_plan_tier`,
  `saas_plan_name`, `saas_monthly_value`, `saas_currency`, `saas_trial_end_date`,
  `saas_renewal_date`, `saas_seat_count`, `saas_csm_owner`), auto-provisioned by
  `ensureSaasCustomerFields()` — the same GET-fields-then-POST-if-missing pattern as
  `ensureEcomProductStyleFields`. **This is the load-bearing safety rule of the whole module**:
  it never guesses at, overwrites, or reads assumptions into a column the client already uses for
  their own purposes — every other design choice below exists in service of that rule.
- **ERPNext's role is narrowed to exactly what it's for: generating the actual invoice/quote
  documents**, not modeling who the customers are. The push mechanism itself
  (`erpnextPushSalesDoc`/`erpnextPushPaymentEntry`/`erpnextSubmitDocByName`) is reused completely
  unchanged from the Accounting module — only the *trigger data* (customer name/phone) now comes
  from the resolved NocoDB row instead of `fp_customers`/a linked Lead, via a synthetic
  `{Name, Phone}` object standing in for a Lead record.
- **`fp_customers`' SaaS-specific columns (migration 0025) and the old accounting.html-nested
  "🚀 SaaS Ops" tab are not deleted, just no longer used for SaaS Ops** — this repo's migrations are
  additive-only (no down-migrations anywhere), so the leftover columns stay, inert. The accounting.html
  tab and its JS were removed outright (not left as a stale second UI) once the standalone
  `frontend/saas-ops.html` page replaced it.

### No OAuth apps — paste-your-own-key pattern
Registering an OAuth app with each of Stripe, Chargebee, Paddle, Zendesk, Intercom, and Freshdesk
needs a live developer account per provider. Instead this reuses the pattern already in this
codebase for ERPNext (`accounting.html`'s `erpBaseUrl`/`erpApiKey`/`erpApiSecret` fields): a client
pastes their **own** API key(s) for their own provider account into 🚀 SaaS Ops → Integrations,
saved via `PATCH /saas/config` onto `saas_config`. Billing providers additionally get a webhook
secret to paste into their own provider dashboard, pointed at the webhook URL shown on that same
screen (`/saas/webhooks/<provider>/<client_id>`).

**None of the six provider integrations below have been exercised against a live account in this
build** — each is implemented to that provider's own publicly documented, stable API/webhook shape
(Stripe's especially well-established). Verify with a real test webhook (Stripe CLI's `stripe
trigger`, Chargebee/Paddle's own webhook test-send, a real API call to Zendesk/Intercom/Freshdesk)
before relying on this in production.

### Schema (migration 0025 + migration 0027)
- **`saas_config`** (migration 0027, replaces `fp_config` for this module) — `client_id`,
  `nocodb_customers_table_id`, `stripe_secret_key`/`stripe_webhook_secret`,
  `chargebee_site`/`chargebee_api_key`/`chargebee_webhook_secret`,
  `paddle_api_key`/`paddle_webhook_secret`, `support_provider`/`support_api_key`/`support_subdomain`,
  `usage_ingest_token` (bearer token for the usage-event endpoint, generated on first Integrations
  load).
- **`saas_collections`** (migration 0027, replaces `fp_expected_dues`/`fp_collections` for this
  module) — one row per payment received from a billing webhook: `client_id, nocodb_customer_id,
  amount, currency, source, occurred_at`. Every SaaS billing event already originates from a
  provider telling us a charge succeeded, so a plain ledger is sufficient — no "expected due"
  concept needed here the way Financial Planning's own recurring-billing tracking needs one.
- **`saas_unmatched_billing_events`** (migration 0027) — a billing webhook event whose customer
  email/phone didn't match any row in the client's configured NocoDB customers table. Never
  blind-written into that live table on a guess; surfaced in the 🚀 SaaS Ops → ⚠️ Unmatched Events
  sub-view for manual reconciliation (link it to the right account by hand — see
  `handleSaasUnmatchedEventResolve`).
- **`saas_usage_events`** — product usage/PQL ingestion, `client_id, customer_id, event_name,
  event_count, occurred_at`, where `customer_id` is the NocoDB row's `Id`.
- **`saas_activation_milestones`** + **`saas_account_milestones`** — client-configurable milestone
  checklist + per-account completion (`customer_id` = NocoDB row `Id`). **Deliberately not built on
  `pipeline_followups`** (migration 0013) — that table is uniquely keyed one row per `lead_id`,
  anchored to pipeline Stage, incompatible with an account needing several independent milestones
  tracked at once.
- **`saas_support_signals`** — periodic ticket-count/avg-CSAT rollups per period, pulled (not
  webhook-pushed) once a day.
- **`saas_touchpoints`** — CSM check-ins/QBRs/escalations log (`customer_id` = NocoDB row `Id`).
- **`saas_surveys`** — NPS/CSAT send + response tracking (`customer_id` = NocoDB row `Id`).
- **`saas_battlecards`** — per-competitor feature/pricing comparison data, feeds the FAQ prompt.
- **`saas_account_reminders`** — generic account-anchored reminder (`reminder_type, anchor_at,
  offset_days, sent_at`), for renewal (90/60/30 days out) and activation-stall nudges
  (`customer_id` = NocoDB row `Id`).

`fp_customers`/`fp_expected_dues`/`fp_collections`/`fp_config` (Financial Planning's own tables) are
**no longer read or written anywhere in this module** — they stay exactly as Financial Planning's
own recurring-billing tracking uses them, fully separate.

### Column-name resolution — reading/matching an arbitrary client-owned table
Since this app has no idea what a client actually named their own columns, two helpers do
alias-based matching against a small list of common spellings per logical field
(`SAAS_CUSTOMER_FIELD_ALIASES` — name/email/phone/start-date):
- **`saasGetCustomerField(row, aliases)`** — case/punctuation-insensitive match against a single
  row's own keys, returns the *value*. Used for display (customer name/phone in the UI) and for
  building the ERPNext bridge's synthetic Lead-shaped object.
- **`saasResolveColumnName(rows, aliases)`** / **`saasResolveColumnNames(env, tableId)`** — same
  matching, but returns the matched *column name* (cached per table), so a billing webhook's
  email/phone lookup can build an efficient server-side NocoDB `where=(<realColumn>,eq,<value>)`
  filter instead of downloading the whole table per event.

### Billing webhooks (`cloudflare-worker/worker.js`)
`handleSaasStripeWebhook`/`handleSaasChargebeeWebhook`/`handleSaasPaddleWebhook`, routed at
`/saas/webhooks/<provider>/<client_id>` (the URL's `client_id` is a lookup key only, same
`/financial/razorpay-webhook/<clientId>` shape as the Razorpay webhook above — the real trust
boundary is the signature/token check against that specific client's own `saas_config` secret).
Each provider's payload is normalized into one shared shape and applied by
`saasApplyBillingEvent()`:
1. Resolve `saas_config.nocodb_customers_table_id` for the client — no table configured yet →
   the event lands in `saas_unmatched_billing_events` and nothing else happens.
2. Match the event's customer email (then phone) against the table via
   `saasFindCustomerByEmailOrPhone()` — no match → same `saas_unmatched_billing_events` fallback,
   **never** a blind-created row in the client's live table.
3. On match, `ensureSaasCustomerFields()` provisions the `saas_*` columns if needed, then only
   those columns are ever written (lifecycle stage, plan, monthly value). `payment_succeeded`
   additionally inserts into `saas_collections` and runs the ERPNext bridge (below).

Signature schemes (all HMAC-SHA256, timing-safe compared): Stripe's `Stripe-Signature: t=…,v1=…`
over `${t}.${rawBody}`; Paddle's `Paddle-Signature: ts=…;h1=…` over `${ts}:${rawBody}`; Chargebee
doesn't HMAC-sign by default, so its "signature" here is a shared token compared from the webhook
URL's `?token=` query param against `saas_config.chargebee_webhook_secret`.

### ERPNext automation — beyond the initial invoice/payment push
Three additions on top of the base `erpnextPushSalesDoc`/`erpnextPushPaymentEntry` bridge, all
best-effort (a failure here never blocks the billing/reminder logic that triggered it — it's
logged via `reportOpsError` and the D1-side state stays correct either way). The customer's
name/phone for each of these now comes from the resolved NocoDB row (via `saasGetCustomerField`)
wrapped in a synthetic `{Name, Phone}` object, since `erpnextResolveCustomer`/`erpnextPushSalesDoc`
only ever read those two fields off whatever Lead-shaped object they're passed — no signature
changes were needed to reuse them:

- **Auto-submit billing-webhook-created documents.** The pre-existing manual Quote/Invoice flow
  (accounting.html's "Sync" then "Publish" buttons) leaves a synced document as an ERPNext Draft
  until a human clicks Publish — correct there, since a human is reviewing it. A billing webhook has
  no human in the loop, so leaving its Sales Invoice/Payment Entry as an unpublished Draft would mean
  it never actually posts to the client's ledger. `erpnextSubmitDocByName()` (factored out of
  `handleAccountingDocumentSubmitErpnext`'s own submit logic, so both paths call the identical Frappe
  sequence) is called automatically right after sync in `saasApplyBillingEvent`'s `payment_succeeded`
  branch.
- **Disable/re-enable the ERPNext Customer on churn/reactivation.** `erpnextFindCustomer()` (a
  search-only sibling of `erpnextResolveCustomer` — never creates) looks up the matching Customer by
  name when an account's `subscription_cancelled`/`subscription_active` event lands; if found,
  `erpnextSetCustomerDisabled()` toggles Frappe's own `disabled` flag. A churned account that was
  never synced to ERPNext has nothing to disable — silently skipped rather than creating a Customer
  record just to immediately disable it.
- **Auto-draft a renewal Quotation.** When the 30-day renewal reminder fires (`type==='renewal_30'`
  in `runSaasRemindersForAllClients`), a Quotation for the account's current `saas_plan_tier`/
  `saas_monthly_value` is created in `accounting_documents` and pushed to ERPNext — left as a
  Draft, **not** auto-submitted, since a quotation is a proposal a human should actually
  review/adjust before it goes out, unlike the invoice/payment case above which is a completed
  transaction.

**Deliberately not used: ERPNext's native Subscription/Auto Repeat doctypes.** Frappe has its own
scheduler that can auto-generate recurring Sales Invoices from a Subscription record — the obvious-
looking "more automation" move. Not wired up here: the billing-webhook-driven invoice creation in
`saasApplyBillingEvent` (and Financial Planning's own independent `fp_expected_dues` generation for
*that* module) are already generating invoices; layering ERPNext's own recurring-invoice scheduler
on top would risk **double-invoicing** the same billing period from two independent schedulers with
no shared state between them.

### Usage ingestion
`POST /saas/usage-event`, `Authorization: Bearer <saas_config.usage_ingest_token>` — call this from
the client's **own** product backend on real usage events, where `customer_id` is the NocoDB row's
`Id` (visible in 🚀 SaaS Ops → 👥 Accounts). Feeds the health score and the weekly customer value
update. Viewable (not just write-only) via `GET /saas/usage-events` and the 🚀 SaaS Ops → 📈 Usage
sub-tab.

### Health score (`computeAccountHealthScore`)
Deterministic, rule-based (not an LLM call per account — cheap enough to recompute for every
account, every day): starts at 50, then adjusts for recent-collection recency (`saas_collections`),
30-day usage trend (vs. the prior 30 days), and support ticket volume/CSAT. **Drops the
lead-sentiment (`WinProbability`) term the v1 version had** — a bare NocoDB customer row has no
reliable `lead_id` chain to a Lead's sentiment score the way `fp_customers` did; billing + usage +
support signals still drive it, and sentiment could be re-added later via the same phone-based
lookup the reminders/digests use, if wanted. Recomputed daily by
`runSaasHealthScoresForAllClients` (iterates every client's NocoDB customers table via
`saasFetchAllCustomers`) unless `saas_health_score_manual==='Yes'` or the account is churned.

### Support-ticket signals — pulled, not pushed
`pullZendeskSignals`/`pullIntercomSignals`/`pullFreshdeskSignals`, called daily by
`runSaasSupportPullForAllClients` for every client with `saas_config.support_provider` set. One
auth pattern (an API key) instead of three more provider-specific webhook signature schemes with no
live account to verify them against.

### Reminders & weekly digests (Cloudflare Cron Triggers)
`runSaasRemindersForAllClients` (renewal 90/60/30-day nudges + one activation-stall nudge) and the
weekly `runWeeklyOwnerDigest`/`runWeeklyCustomerValueUpdate` all now iterate every client's own
NocoDB customers table (`saasFetchAllCustomers`) instead of scanning `fp_customers`, and resolve
messaging by **phone** — `saasFindLeadConversationByPhone(env, clientId, phone)` (a NocoDB
`where=(ClientId,eq,X)~and(Phone,eq,Y)` query against LEADS for `ConversationID`), using the
phone value read off the NocoDB row via `saasGetCustomerField` — instead of the old `lead_id`
chain, since a bare NocoDB customer row has no `lead_id`. Sent via the same Chatwoot
conversations-API pattern as `fpSendRemindersForClient`.

The activation-stall nudge (7+ days in `onboarding` with zero completed milestones) prefers a
recognizable start-date-like column on the client's table (`saasGetCustomerField` against the
`startDate` alias list) when one exists, and falls back to "always eligible" when it can't
recognize one — a client's table isn't guaranteed to have anything resembling a signup date.

`runSaasRemindersForAllClients`/`runSaasSupportPullForAllClients`/`runSaasHealthScoresForAllClients`
are piggybacked onto the existing daily `0 2 * * *` tick; `runWeeklyOwnerDigest`/
`runWeeklyCustomerValueUpdate` use the explicit 4th cron string (`0 9 * * 1`, Mondays 09:00 UTC) in
`wrangler.toml` — none of the cron *call sites* changed for this rework, only the functions'
internals. The weekly owner digest **drops the "new accounts this week" stat** the v1 version had —
there's no reliable client-controlled created-at column on an arbitrary NocoDB row to key off
without further column-guessing; revenue collected and churned/at-risk counts are unaffected.

### FAQ prompt (`engineBuildFaqSystemPrompt`, `worker.js`)
A third industry branch (alongside the existing `ecommerce`/`travel` ones) for
`industry==='saas_digital_marketing'`, fed by `engineBuildSaasContext()` — looks the customer up by
**phone** in the client's configured NocoDB table (`saasFindCustomerByEmailOrPhone`, email arg
null) instead of `fp_customers.phone`, surfacing `saas_plan_tier`/`saas_trial_end_date`/
`saas_renewal_date`/`saas_seat_count`/`saas_lifecycle_stage` plus `saas_battlecards` rows, so "how
are you different from X" gets a real answer when a battlecard covers it, and an honest "I'll find
out" when it doesn't, instead of an invented comparison.

### Frontend (`frontend/saas-ops.html` — own top-level `dashboard.html` tab)
**Moved out of `accounting.html` into its own standalone page**, following the exact iframe-embed
pattern already used for Ecommerce/B2B/Accounting (`renderEcommerce`/`renderB2b`/`renderAccounting`
in `dashboard.html`): a `.dnTab.industry-tab[data-industry="saas_digital_marketing"]` nav button
(auto-shown/hidden by `applyTheme()`'s existing `.industry-tab` loop — no new visibility JS needed),
a `<div class="page hidden" id="pageSaasops"><iframe id="saasOpsFrame">`, `renderSaasOps()` lazy-
loading `saas-ops.html?client=<id>&token=<token>&embed=1` (needs the session token — every `/saas/*`
route is `requireSession`-gated), and one line in the central page-switch dispatcher. Sub-nav, in
order: **📊 Dashboard**, **👥 Accounts**, **✅ Activation**, **📈 Usage**, **⚔️ Battlecards**, **🤝
Touchpoints & Surveys**, **⏰ Reminders** (read-only log), **⚠️ Unmatched Events** (new — the
reconciliation UI for the billing-webhook-matching fallback above), **🔌 Integrations**.

- **📊 Dashboard** — the same `/saas/reports` payload the Reports page's "📈 SaaS" sub-tab uses
  (`handleSaasReports`, now computed from the NocoDB table's `saas_*` fields + `saas_collections`):
  full-width stat tiles, a Chart.js revenue-trend bar chart, a health-score doughnut, an
  activation-funnel horizontal bar chart, and full-width At-Risk/Renewal/Expansion tables.
- **👥 Accounts** — `renderSaasAccountsBoard()`: one column per lifecycle stage
  (Onboarding/Active/At Risk/Renewal/Expansion/Churned), cards built from `GET /saas/customers`
  (the client's live NocoDB table, `handleSaasCustomersList` — every original column plus the
  `saas_*` computed fields and alias-resolved `_name`/`_email`/`_phone`). Clicking a card opens an
  edit modal that **only ever writes the `saas_*` fields** via `PATCH /saas/customers`
  (`handleSaasCustomerUpdate`) — the account's own columns are shown as read-only, edited in
  NocoDB directly.
- **📈 Usage** — `GET /saas/usage-events` (`handleSaasUsageEventsList`, unchanged from v1) returns
  a 30-day per-account/per-event-name summary plus a capped recent-events log.
- **⚠️ Unmatched Events** — lists `saas_unmatched_billing_events`, with a per-row account picker
  + "Link" button (`POST /saas/unmatched-events/resolve`) that replays the collection/lifecycle
  effect the webhook would have had, now that the right account is known.
- **🔌 Integrations** — the "NocoDB Customers Table" card is now the primary, first setting on this
  page (`saveSaasNocodbTable()` → `PATCH /saas/config`) — pointing this at the client's live table
  is what makes the rest of the module work, replacing the old one-time "Fetch & Import" flow.
- `dashboard.html`'s Reports page "📈 SaaS" sub-tab (`renderReportsSaas`) needed no data-shape
  changes — `handleSaasReports`'s response shape is unchanged — only its empty-state copy was
  updated to point at 🚀 SaaS Ops → Integrations.
- The lead detail panel's "🚀 Linked Account" card now looks the open lead's `Phone` up against
  `GET /saas/customers`' `_phone` field instead of matching `fp_customers.lead_id`.

### Manual test checklist (no live provider credentials exist in this build)
- **NocoDB connection**: set a real Table ID in 🚀 SaaS Ops → Integrations, confirm 👥 Accounts
  populates and that only new `saas_*` columns appear on the live table — no existing column's
  value changes.
- **Billing**: `stripe listen --forward-to <worker>/saas/webhooks/stripe/<client_id>` +
  `stripe trigger invoice.paid` with a test customer email that matches a real row in the
  configured table → confirm a `saas_collections` row appears, the row's `saas_*` fields update,
  and (if ERPNext is also connected) a Sales Invoice + Payment Entry appear in that client's real
  ERPNext site. Retry with a non-matching email → confirm it lands in ⚠️ Unmatched Events instead
  of creating anything in the live table.
- **Usage**: `curl -X POST <worker>/saas/usage-event -H "Authorization: Bearer <token>" -d '{"customer_id":<a real NocoDB row Id>,"event_name":"test"}'`
  → confirm the next day's health-score recompute reflects it.
- **Cron**: confirm `wrangler.toml`'s `crons` array and the `scheduled()` dispatcher's `event.cron`
  checks match exactly, character-for-character, especially the `"0 9 * * 1"` weekly string.

## AI Sales Plan (`frontend/dashboard.html` — Leads page → 🧠 AI Analyst → "🤖 AI Sales Plan" tab)

A ranked daily worklist, **not an autonomous agent** — every action needs a click. Computed entirely
client-side over `allLeads` (same "pure computation, no new backend route" convention as
`renderAiReps`/`renderAiOverview`), so it's always in sync with whatever's already loaded on the
page and needs no storage of its own.

### Ranking (`aiSalesPlanScore`)
A deliberately simple, explainable weighted sum over signals already on the lead record — Score
(Hot +40/Warm +20), a Hot Moment flag (+15), days since last activity (`LastMsgAt||Date`, capped at
+24), deal value (log-scaled, capped at +24), and a human-handover SLA-risk bump (+15 once
`HandoverAt` is more than 30 minutes old). Each contributing signal becomes a reason chip on the
lead's row (e.g. "🔴 Hot · 4d no reply · AED 50,000 deal"), so a rep can see exactly why a lead is
ranked where it is rather than trusting an opaque score. Excludes only actually-resolved leads
(`isWonLead`/`isLostLead`) and opted-out ones — **deliberately does NOT use this file's usual
`!TERMINAL.has(l.Stage)` "active leads" filter**, since `TERMINAL` includes `human_handover` and a
lead mid-handover is exactly the most actionable item for a rep-facing worklist (that blanket
exclusion exists elsewhere to keep the *bot*/Automations from touching a handed-over lead, not to
hide it from the human who now owns it). Top 20 shown, sorted by score. Each row: 📞 Call
(`callHrefFor`), 💬 WhatsApp (opens the existing Send Template modal for that one lead), and a
session-only ⏭️ "Skip for today" that never touches the lead record or any backend — it's just
removed from this render pass.

### Intro Media Auto-send
"Send an intro video/PDF to every fresh lead N hours after they come in" maps directly onto the
existing Automations & Flow engine (`⚡ Automations`, `frontend/broadcast.html`) rather than needing
new scheduling machinery: a `new_lead` trigger with an empty segment (`leadsAudienceWhereClause`
with no `stage`/`tags_any` resolves to "every lead for this client") already auto-enrolls every
fresh lead, and a `wait` step already exists. The only missing piece was a step that sends a real
file instead of text — see "Send WhatsApp Media step" below. This card manages exactly **one**
reserved-name flow (`🎬 AI Sales Plan — Intro Media`) through the same `/automations/flows`
GET/POST/PATCH routes the full flow editor uses (`aiSalesPlanLoadIntroFlow`/
`saveAiSalesPlanIntroMedia`) — a 3-field quick-setup (delay hours, Drive link, caption) instead of
the full editor, for the one specific use case this card exists for. Opening that same flow by name
in the full Automations editor gives full control (audience restriction, extra steps) if the quick
form isn't enough.

### Conversion timing — "When conversion is high" (Rep Performance tab)
Extends the existing Rep Performance tab's Activity-by-Hour/Activity-by-Day bar charts (raw message
volume, from `LastMsgAt||Date`) with a second pair of charts bucketing the same hour/day by actual
Won-rate (`isWonLead`/`isLostLead`) instead of volume — deliberately kept as two separate chart
pairs rather than one overlay, since the two numbers frequently point at different times (the
busiest hour is often just a queue backing up, not the hour deals actually close). A "When
conversion is high" note calls out the top hours by win rate (minimum 3 resolved deals in that
bucket, to avoid a single lucky/unlucky hour looking meaningful).

## Send WhatsApp Media step + follow-up media attachments (`cloudflare-worker/worker.js`)

A shared building block — fetch one Google Drive file (video/image/audio/PDF) and forward it into a
Chatwoot conversation as a real attachment — reused by two features above and beyond the Hospitality
module's existing per-unit media send:

- **`driveGuessFilename(contentType)`** — maps a fetched Drive file's content-type to a sane
  filename+extension (`video.mp4`, `image.jpg`, `audio.mp3`, `document.pdf`, …) so WhatsApp/Chatwoot
  render it as the right kind of attachment (inline video player, image preview, audio player,
  document icon) rather than a generic untyped blob.
- **`sendDriveMediaToChatwoot(c, convId, driveUrl, caption)`** — resolves the Drive file id
  (`driveFileId`), fetches its bytes (`driveFetchFile`, both pre-existing from the Hospitality
  media switch), and POSTs a Chatwoot attachment message — the same FormData-with-`attachments[]`
  shape `hospitalitySendUnitMedia` already uses, generalized to any single Drive link rather than a
  fixed set of unit photo/video slots. Never throws; returns `false` on anything that didn't work
  (unshared file, bad link, Chatwoot failure) so every caller can treat it as best-effort.

**Automations & Flow** (`⚡ Automations`, `broadcast.html`) gains a 6th step type,
`send_whatsapp_media` (`{type:'send_whatsapp_media', media_url, caption}`) — validated in
`validateAutomationFlow` (needs a non-blank `media_url`) and executed in `advanceFlowLead` exactly
like the existing `send_whatsapp_dm` step, just calling `sendDriveMediaToChatwoot` instead of a
plain-text Chatwoot POST. `caption` runs through the same `fillFlowTokens` `{name}`/`{stage}`/
`{phone}` substitution as every other step's text.

**Follow-up Engine** (`💪 Follow-up Engine` tab, classic 3-step sequence) gains an optional media
attachment **per variant** — `migrations/0024_followup_variants_media.sql` adds
`media_url`/`media_caption` (both default `''`, additive-only ALTER on the existing
`followup_variants` table from `migrations/0007_followup_engine.sql`). `pickFollowupVariant` now
also returns `mediaUrl`/`mediaCaption` for whichever variant was picked; `handleBroadcastFollowupSend`
sends the variant's text (or voice) exactly as before, then — if a `media_url` is set — sends the
Drive file as a second message via `sendDriveMediaToChatwoot`. `handleFollowupVariantsList`/
`handleFollowupVariantsSave` were extended to read/write the two new fields alongside the existing
CTA/incentive/social-proof ones, and the variant-editor grid in `broadcast.html` gained matching
"Media (optional)" + "Media caption" inputs per variant cell (`fuv_${step}_${variant}_media_url`/
`_media_caption`, same `fuEngineFieldId` convention as every other field on that grid).

## DDoS protection

Two layers, matched to what each piece of the stack can actually do. Neither layer touches any
authenticated route or any external webhook (Shopify/Stripe/Chargebee/Paddle/Razorpay/WhatsApp
engine/Instagram/Cal.com/Chatwoot/render-pipeline) — those already pay for their own
signature/HMAC verification, and a legitimate burst on any of them (a broadcast send fanning out
replies, a flash-sale spike of Shopify orders) must never be mistaken for an attack.

**1. App-level rate limiting (shipped in code, live on next deploy — no dashboard step needed).**
`cloudflare-worker/worker.js`'s `RATE_LIMIT_RULES` (+ `checkRateLimit`/`clientIp`, right after
`json()`) puts a per-IP fixed-window counter, backed by D1 (`migrations/0030_rate_limit_counters.sql`,
`env.DB` — same binding every other D1-backed module already uses), in front of the only routes an
attacker can hit *without* a valid session token: `POST /session/exchange`, `POST /admin/login`,
`POST /ecom/public/order`, `POST /appt/public/book`, `POST /b2b/doc/:id/accept`, and the public
storefront/booking GET reads (`/ecom/public/*`, `/appt/public/*`). Limits are deliberately generous
(30–120 requests per window depending on the route) so no real customer placing an order or booking
a slot ever notices; a `429` with `Retry-After` is returned only once a single IP blows well past
normal usage. The check **fails open** — any D1 error lets the request through rather than blocking
it, so a rate-limiter bug can never itself take down login/checkout/booking. Expired counters are
swept daily, piggybacked on the existing 2am cron (`cleanupRateLimitCounters`, same "share a tick"
convention as every other daily sweep in `scheduled()`) rather than a new cron string.

**2. Origin-level rate limiting (shipped in code).** `frontend/nginx.conf` gained
`limit_req_zone`/`limit_req` (20r/s per IP, burst 40, `nodelay` so the burst is served immediately
rather than queued — invisible to a normal page load) across all three vhosts, as a backstop behind
Cloudflare for the static site itself. This only takes effect because `frontend/Dockerfile` was also
fixed to `COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf` — previously the file existed in
the repo but nothing copied it into the image, so nginx was silently running on the bare
`nginx:alpine` default vhost (no multi-domain routing, no rate limiting either). Worth confirming
after the next deploy that `app.leadvyne.com` etc. still route correctly, since this is the first
time that vhost config has actually been active.

**3. Cloudflare account/dashboard steps (NOT shippable from this repo — no Cloudflare API
credentials are available in this environment; do these once, by hand, in the Cloudflare
dashboard):**
- Confirm `leadvyne.com`, `app.leadvyne.com`, and `onshope.com` are proxied (orange cloud), not
  "DNS only" — `app.leadvyne.com`'s API already benefits from this via the Worker, but the static
  site's own DNS records need the proxy on too for Cloudflare's network-layer DDoS protection and
  WAF to apply to it at all.
- If `whizz.aiingo.com` (NocoDB), `secure.leadvyne.com` (Authentik), or `app.aiingo.com` (Chatwoot)
  are on Cloudflare DNS, proxy those too — they're self-hosted origins with no protection of their
  own today. Better still, put them behind **Cloudflare Tunnel** (`cloudflared`) so their origin IPs
  are never publicly routable at all — a firewall rule allowing only Cloudflare's published IP
  ranges is the fallback if Tunnel isn't practical short-term.
- Turn on **Bot Fight Mode** and the **WAF managed ruleset** (Security tab) for every proxied zone.
- Add **Rate Limiting Rules** (Security → WAF → Rate limiting rules) for extra coverage on
  `app.leadvyne.com` — the Worker's own limiter above covers the specific abuse-prone routes, but a
  dashboard rule adds edge-level coverage before a request even reaches the Worker.
- Keep **"I'm Under Attack" mode** in mind as the emergency toggle during an active incident — it
  adds a JS challenge in front of every request, so only flip it on for the affected zone and only
  for the duration of the attack (it will interrupt normal users while enabled).
- Set spending alerts/caps on Stripe, Gemini, Resend, Sarvam, and any other pay-per-call provider
  this Worker fans out to — Cloudflare's edge can absorb a volumetric flood for free, but every
  request that *does* reach the Worker still spends real money on whichever paid API it calls
  (`STRIPE_SECRET_KEY`, `GEMINI_API_KEY`, `RESEND_API_KEY`, `SARVAM_API_KEY`, …), so a "cost DoS"
  is a separate risk from downtime and isn't mitigated by anything above.

## Engine event log (`frontend/dashboard.html` — Settings → 🪵 Logs, `cloudflare-worker/worker.js`)

`handleEngineWebhook` has always had ~12 silent "skip" conditions (rate-limited, duplicate
delivery, handed over to a human, opted out, missing OpenRouter key, etc) that return `{ok:true,
skipped:'<reason>'}` and go no further — correct behavior, but previously invisible outside raw
Cloudflare Worker logs (account-level access only, not scoped per client, and easy to mistake for
"the bot is broken" when it's actually working as designed). This surfaces that reasoning directly
in the dashboard.

- **`migrations/0031_engine_event_log.sql`** — new D1 table `engine_event_log` (client_id, phone,
  conv_id, reason, detail, created_at). Sidecar data with no other reader, same rationale as every
  other D1 table in this repo.
- **`logEngineSkip(env, clientId, phone, convId, reason, detail)`** (worker.js, next to the DDoS
  rate-limit helpers) — best-effort, fail-open insert, called right before each of
  `handleEngineWebhook`'s existing skip `return`s (client-inactive, engine-disabled-client,
  account-mismatch, duplicate-delivery-fast, not-actionable, test-mode, no-openrouter-key,
  duplicate-delivery, handed-over, opted-out, rate-limited) and once more from the catch block for
  `internal-error`. Purely additive — none of the actual skip logic, return values, or control flow
  changed; logging can never affect whether or how the bot replies. Swept daily (30-day retention),
  piggybacked on the existing 2am cron like every other daily sweep in `scheduled()`.
- **`GET /engine/logs`** (session-gated, optional `?phone=` filter) — merges `engine_event_log`
  with the *successful*-turn rows already sitting in `ENGINE_ANALYTICS_TABLE` (NocoDB,
  `engineLogAnalytics`, pre-existing — the same data the Reports → 💬 WhatsApp tab reads) into one
  timeline sorted newest-first. No new writer needed for the "replied" half; this is additive on
  the read side only.
- **Settings → 🪵 Logs** — new sub-tab alongside General/Channels/Integrations/Voice/Modules (same
  `settings-subnav-btn` pattern, added to `SETTINGS_GROUP`/`MORE_GROUP`). A phone-number filter box
  plus a table of When/Phone/Result/Reason/Detail, `logsInit()` calling the endpoint above. Result
  is color-coded: ✓ Replied / ⏭ Skipped / ✗ Error.

## Real-time dashboard updates (`cloudflare-worker/worker.js`, `frontend/dashboard.html`)

Before this, a new inbound WhatsApp/Instagram message only ever reached an open dashboard tab via
the 60s `loadAll()` poll — up to a minute of dead air on something that just happened, and the
Chats tab specifically had no live-refresh path at all (its contact list/open thread were never
touched by that poll either, only Home's widgets were).

- **`ClientUpdatesHub`** (worker.js) — a Durable Object, one instance per client
  (`env.CLIENT_UPDATES.idFromName(clientId)`), holding that client's currently-connected dashboard
  WebSockets. Uses the Hibernatable WebSockets API (`state.acceptWebSocket`/`getWebSockets`) rather
  than holding sockets in a plain in-memory field, so an idle DO with open connections isn't billed
  as continuously active. Requires the new `[[durable_objects.bindings]]`/`[[migrations]]` blocks in
  `wrangler.toml` — picked up automatically on the next `wrangler deploy`, no separate manual
  create/paste-id step.
- **`GET /engine/live`** (`handleEngineLiveSocket`) — the WebSocket upgrade endpoint. Auth is the
  same signed session token used everywhere else, just passed as a `?token=` query param instead of
  an `Authorization` header (browsers can't set custom headers on a WebSocket handshake) — not a
  separate auth scheme. Routed early in the Worker's `fetch()`, bypassing the generic CORS-header
  response rebuild at the bottom of that function (which would silently drop a 101 response's
  `webSocket` pairing).
- **`engineBroadcastUpdate(env, clientId, eventObj)`** — best-effort/fail-open, called from
  `handleEngineWebhook`'s WhatsApp and Instagram paths the moment a real inbound message finishes
  processing (right after the lead upsert resolves an id), posting a small `{type:'message',
  lead_id, channel, at}` event to that client's `ClientUpdatesHub`, fanned out to every connected
  socket. Skip conditions (rate-limited, duplicate, etc.) do NOT broadcast — only genuine processed
  messages do.
- **`connectLiveUpdates()`/`onLiveMessageEvent()`** (dashboard.html) — opens the socket right after
  login (alongside the first `loadAll()`), reconnects with a 5s delay on any close as long as the
  app is still open, and on a `message` event force-refreshes leads (`loadAll(true, true)` — the
  new `force` param bypasses the 5-minute sessionStorage cache TTL) plus, only while the Chats tab
  is actually visible, re-renders the contact list and the open thread if it's the lead that just
  got the message. Purely additive — the 60s poll and 5-minute cache are both untouched as the
  fallback if the socket is ever closed/reconnecting.

## Conversation history summarization (`cloudflare-worker/worker.js`)

`ConvHistory` is capped at the last 40 turns (`engineBuildLeadUpsertBody`), and only the last 20 of
those (`activeHistory`) actually reach the FAQ/objection prompts — a lead whose conversation runs
past that cap previously lost all memory of anything discussed before it, even though the
conversation was still ongoing.

- **`ConvSummary`** (Leads table, auto-created via `ensureLeadsColumns` the first time it's
  actually needed — no manual NocoDB setup step) — a short rolling summary of everything the
  40-turn cap has already dropped.
- **`engineMaybeSummarizeHistory(env, c, fullHistory, priorSummary)`** — regenerates the summary
  every `ENGINE_SUMMARY_EVERY_N_TURNS` (10) turns once history first crosses the cap, folding the
  prior summary together with a bounded slice (last 30) of the older messages into one short
  updated summary via a single `engineCallLlm` call. Bounding that input, not how often this runs,
  is what keeps cost flat as a conversation runs arbitrarily long — it's always summarizing one
  fixed-size window, never the whole history from scratch. Called from both
  `handleEngineWebhook`'s WhatsApp and Instagram paths right after `engineBuildLeadUpsertBody`
  resolves the turn's `ConvHistory`, before the lead upsert.
- **`engineSummaryBlock(state)`** — shared by `engineBuildFaqSystemPrompt`/
  `engineBuildObjectionSystemPrompt`, injecting `state.summary` as a "## Earlier in This
  Conversation" section before "## Recent Conversation" so the two read in actual chronological
  order. Empty (a no-op) for the vast majority of leads, which never cross 40 turns at all.

## WhatsApp interactive quick-reply buttons (`cloudflare-worker/worker.js`)

Chatwoot's own message-create endpoint accepts an optional `content_type`/`content_attributes`
pair (confirmed against Chatwoot's own source — `Messages::MessageBuilder` reads
`content_attributes` either as a nested hash or a JSON string over multipart form-data, and
`Whatsapp::Providers::WhatsappCloudService#create_payload_based_on_items` turns `content_type:
'input_select'` + `content_attributes: {items:[...]}}` into a real WhatsApp Cloud API interactive
button message for ≤3 items) that this Worker previously never used, sending plain text only.

- **`engineSendChatwootQuickReply(env, c, clientId, convId, text, items)`** — same endpoint/auth as
  `engineSendChatwootReply`, plus those two extra form fields. `items` is `[{title, value}]`,
  defensively capped at 3 items / 20-character titles (WhatsApp Cloud API's own real limits) so a
  caller can't produce a payload that gets silently rejected downstream by Meta. Falls back to a
  plain `engineSendChatwootReply` on no valid items, a missing convId/creds, or any send failure —
  same "customer gets the plain-text reply they'd have gotten before this existed" fallback
  reasoning as the image/audio reply functions.
- **`engineDeliverReply`**'s options gained an optional `quickReplies` array, routed to the function
  above when present (checked after the image/voice branches, same precedence order).
- **Wired into exactly one flow so far**: the `objection` route's LLM-generated reply now carries a
  single "🙋 Talk to a human" button alongside the text. Tapping it sends its title back as an
  ordinary incoming WhatsApp text message (Chatwoot's own behavior for a button reply) — no new
  receive-side parsing needed, since `engineClassifyIntent`'s existing WANTS_HUMAN keyword match
  already recognizes "talk to a human". Opt out via `bot_config.quick_reply_buttons_enabled`
  (default on). Not wired into FAQ or any other route yet.

## Recruitment & Consultancy module (`frontend/dashboard.html` — 💼 Recruit tab) — rebuilt on D1

Previously the odd one out among the multi-entity modules: Jobs/Candidates/Placements each lived
in a **per-client dynamic NocoDB table** (`RC_Jobs_<clientId>`/`RC_Candidates_<clientId>`/
`RC_Placements_<clientId>`), provisioned by the browser itself calling NocoDB's Meta API directly
on first use ("🚀 Create Tables Now"), with a `CLIENTS.recruit_table_ids` JSON column tracking
which table-id belongs to which client — the same shape Travel Agency/Appointments still use, but
inconsistent with Hospitality/Financial Planning/B2B/Accounting/SaaS Ops, which all use one shared
D1 table keyed by `client_id`. Rebuilt to match that second pattern — no other module behavior
changed, this is a storage-layer swap.

- **`migrations/0032_recruitment.sql`** — three new D1 tables, `recruit_jobs`/`recruit_candidates`/
  `recruit_placements`, each `client_id`-scoped with an index on it (`recruit_candidates` also
  indexes `(client_id, job_id)` for the job→candidates lookups the Qualification Report and AI
  Screen use). Field names match the old NocoDB columns exactly, so no data-shape changes ripple
  into the render functions.
- **`worker.js` — `RECRUIT_TABLES` + `handleRecruitList/Create/Update/Delete`** — one generic
  CRUD implementation shared by all three entity kinds (a config object per kind: table name,
  required field, field list with type coercion) instead of three near-duplicate sets of handlers.
  Every SELECT aliases `id AS Id` so the JSON shape matches exactly what the existing `_rcJobs`/
  `_rcCandidates`/`_rcPlacements` render functions already expect (`c.Id`/`j.Id`/`p.Id` throughout)
  — only the fetch layer needed to change, not every render function reading the records.
  Session-gated (`requireSession`), routes: `GET/POST/PATCH/DELETE /recruit/jobs`,
  `/recruit/candidates`, `/recruit/placements`.
- **Frontend** — `rcLoad()`/`rcCreate()`/`rcUpdate()`/`rcDelete()` now call those routes instead of
  the NocoDB passthrough. `rcTablesReady()`, `renderRcSetupNeeded()`, `rcSetupTables()` ("Create
  Tables Now"), `rcEnsureColumns()`, and the local-cache fallback trio (`rcSaveLocal`/
  `rcLoadLocal`/`rcMergeLocal` — a workaround for a NocoDB schema-just-created write race that
  can't happen against a table that already exists for every client) are all gone; `recruit_enabled`
  is now the only gate, saved with a plain `patchClient()` like every other simple toggle.
- **Not migrated**: any existing data sitting in the old per-client `RC_Jobs_*`/`RC_Candidates_*`/
  `RC_Placements_*` NocoDB tables is untouched and orphaned — this was a fresh rebuild, not a data
  migration. If a client had already used this module before the rebuild, their old rows need a
  one-time manual export/import into the new D1 tables (or a bespoke migration script) before they
  see continuity; the module tables themselves are safe to leave alone in NocoDB or delete later.

## `POST /engine/track` — tracking sync for clients whose replies come from an external n8n flow

For a client with `engine_disabled='Yes'` (so `/engine/webhook` stays silent for them) whose actual
WhatsApp replies are sent entirely by their own n8n workflow: this repo and that workflow have no
API between them, they only ever share one NocoDB `LEADS` table. Every other Leadvyne feature
(Pipeline, Reports, Home, Automations) reads `Stage`/`ConvHistory`/`LastMsgAt` off that table — the
built-in engine writes those as a side effect of replying, but an external n8n flow replying on its
own has no reason to know that contract, so those fields would just go stale for that client.

`handleEngineTrack` (`worker.js`) is the fix: client_id-based, no session (n8n has none), same
shape as `handleLeadBookingLink`/`handleAiObjectionReply`. Body: `{client_id, phone, name?,
incoming_text?, reply_text?, stage?}` (at least one of `incoming_text`/`reply_text` required).
Finds-or-creates the lead by phone, appends both turns to `ConvHistory` (same `{role, content}`
shape/40-message trim the engine itself uses), bumps `LastMsgAt`, and writes `Stage` only if the
caller passes one *and* it's a real stage id in that client's own `flow_json` (never invents a
stage the client hasn't defined — same guard `advanceLeadBookingAndTask` uses). Also logs a row to
`ENGINE_ANALYTICS_TABLE` with `Route:'n8n'` so Settings → Logs and Reports show this activity too,
distinguishable from the built-in engine's own turns.

Deliberately does **not** attempt to reproduce `engineBuildLeadUpsertBody`'s intent/win-probability/
qual-score scoring — n8n has no classifier output to feed that with, so those fields are simply left
as whatever they last were for a lead tracked this way. Call it from n8n right after sending a
reply, once per turn.

**Also fixed while in this area**: `advanceLeadBookingAndTask` and the two lead-lookups in
`handleChatwootMessageHook`'s booking/order auto-tracking were filtering the LEADS table with
`where=(client_id,eq,...)` — the actual column is `ClientId` (PascalCase, confirmed by every other
LEADS read/write in this file). That mismatched filter meant these three lookups always came back
empty, so `/leads/booking-link`'s stage-advance step silently never found the lead it was supposed
to advance, and the auto-tracking webhook's own "already booked" dedupe check never fired either
(risking duplicate booking tasks). Fixed to match every other LEADS query in the file.

## Native Forms (WhatsApp Flows) — optional, per-client (`frontend/dashboard.html` — Settings →
## General → 📋 Qualifying Questions & Native Forms)

Lets a client collect their qualifying questions (`CLIENTS.qual_questions`) as ONE native WhatsApp
form instead of the classic one-question-at-a-time chat ladder (`engineRouteFlow`'s
`qualify`/`qualify_next` routes — unchanged, still the fallback whenever this is off or not yet
synced). Off by default; a client must both flip the toggle on AND click "Sync WhatsApp Form"
before it actually takes effect.

**Qualifying questions now support a per-question "optional" flag.** `qual_questions` entries can
be a plain string (legacy — still treated as required, unchanged) or `{text, optional}`. The
Settings card's per-question checkbox writes the latter shape; `engineQualQuestionText`/
`engineQualQuestionOptional` (`worker.js`) are the one place either shape is read, so every call
site (the chat ladder, the Flow builder, the completion endpoint) agrees.

**Why this needs its own encrypted endpoint, not just the normal engine webhook**: WhatsApp
delivers a completed Flow's answers as an `nfm_reply` interactive message over the SAME inbound
webhook every other WhatsApp message uses — but Chatwoot (this app's inbox/relay for every other
inbound message) is a **confirmed** case of silently dropping that payload
(chatwoot/chatwoot#13970 — `content:null`, the answers never reach anything downstream of
Chatwoot). Rather than depend on a Chatwoot fix, this uses a `data_exchange` screen action instead
of the simpler `complete` action — Meta posts that directly to a business-owned HTTPS endpoint
(RSA/AES-encrypted, Meta's Flow Endpoint spec), bypassing Chatwoot entirely for this one payload.
Everything else (the Flow's own send, every other message) still goes through the exact same
channels as before.

**Setup — one shared RSA keypair for every client** (nothing in Meta's spec requires a distinct key
per WABA; sharing one avoids storing a private key per client in NocoDB, a materially weaker store
than Worker secrets):
```
openssl genrsa -out native_forms_private.pem 2048
openssl rsa -in native_forms_private.pem -pubout -out native_forms_public.pem
wrangler secret put NATIVE_FORMS_PRIVATE_KEY_PEM   # paste native_forms_private.pem's contents
wrangler secret put NATIVE_FORMS_PUBLIC_KEY_PEM    # paste native_forms_public.pem's contents
```
Also needs `META_APP_SECRET` (already required for Embedded Signup — see "Channels module") since
that's what signs `X-Hub-Signature-256` on every call to `POST /native-forms/endpoint`, the only
auth on that route (it's called directly by Meta, no session).

**Flow**: client edits questions + flips the toggle on in Settings, then clicks "Sync WhatsApp
Form" → `handleNativeFormSync` (`POST /native-forms/sync`) registers the shared public key on that
client's WABA, builds the Flow JSON from `qual_questions` (`engineBuildNativeFormFlowJson` — one
`TextInput` per question, `required` mapped from `!optional`), creates+publishes the Flow via the
Graph API, and stores the returned id as `CLIENTS.native_flow_id` (auto-provisioned column). From
then on, a brand-new lead's `qualify` route sends the Flow (`engineSendNativeForm`, direct Graph
API `interactive`/`flow` message, bypassing Chatwoot for the send too) instead of the first chat
question, and `Stage` moves to `awaiting_native_form`. When the customer submits it,
`handleNativeFormEndpoint` decrypts the submission, writes `QualAnswers`, advances `Stage` to the
funnel's first real stage (mirroring the chat ladder's own completion step), and sends that
stage-1 message through the same Chatwoot conversation as everything else.

**Not verified against a live Meta call** — the crypto (RSA-OAEP key unwrap, AES-128-GCM
decrypt/encrypt with the response IV flipped per byte, the `ping`/`data_exchange` contract) and the
Flow JSON shape are implemented directly from Meta's published Flow Endpoint spec; no Meta app with
Flows + encryption enabled was reachable from the dev sandbox this was built in. Test end-to-end —
sync a real Flow, submit it from an actual WhatsApp client — before enabling for a paying client.

## Gemini Live voice provider — optional, per-client (`frontend/dashboard.html` — Settings → 🎙️
## Voice → 🔧 TTS Provider)

A third option (`gemini_live`) alongside the existing Sarvam/AI4Bharat choices in
`CLIENTS.voice_tts_provider`, read by `engineTtsWithFallback` (`worker.js`). Unlike AI4Bharat this
is opt-in ONLY — never an automatic fallback for anyone who hasn't explicitly chosen it, since the
Live API is a real-time bidirectional session, a materially heavier mechanism to reach for one
turn's worth of speech than a plain TTS call.

Uses the same shared `GEMINI_API_KEY` the intent classifier/transcriber already use — no new
secret. `engineGeminiLiveTts` opens a WebSocket to Gemini's `BidiGenerateContent` Live API,
sends the already-composed spoken reply text as one turn, and collects the streamed PCM16 audio
chunks. Since Cloudflare Workers have no audio codec available and this repo's convention is
"anything ffmpeg-shaped runs on the render pipeline, not the Worker," the raw PCM is sent to a new
render-pipeline endpoint, `POST /pcm-to-ogg` (`render-pipeline/lib/pcmToOgg.js`), which converts it
to the Ogg/Opus format WhatsApp needs for a native voice-note bubble — reusing the same
`MARKETING_RENDER_WEBHOOK_URL`/`_SECRET` this Worker already calls for AI4Bharat TTS/transcription.
No new render-pipeline env var needed (stateless ffmpeg conversion, no model to gate behind an
opt-in flag).

**Not verified against a live call** — implemented directly from Google's documented
`BidiGenerateContent` wire protocol (`setup` → `setupComplete` → `clientContent` turn → streamed
`serverContent.modelTurn.parts[].inlineData` chunks → `serverContent.turnComplete`); no
`GEMINI_API_KEY` with Live API access, and no route to `generativelanguage.googleapis.com`'s
WebSocket endpoint, were available in the dev sandbox this was built in. Test with a real client
before relying on it in production.

## Piper voice provider — optional, per-client (`frontend/dashboard.html` — Settings → 🎙️ Voice →
## 🔧 TTS Provider)

A fourth option (`piper`) alongside Sarvam/AI4Bharat/Gemini Live in `CLIENTS.voice_tts_provider`.
Piper (rhasspy/piper, MIT-licensed) is genuinely free: a small local binary + one small neural
voice model, no API key, no per-request cost, no PyTorch (unlike AI4Bharat's ~1.2GB torch stack).
Sounds noticeably better than `lib/tts.js`'s espeak-ng (a real neural voice, not a formant
synthesizer) but isn't a drop-in replacement for Sarvam's quality — documented tradeoff, same as
every other provider here.

**Opt-in ONLY, never an automatic fallback** — the real limitation is language coverage, not
resource cost. Only `en_US-lessac-medium` (Piper's own canonical quickstart voice) is baked into
the render-pipeline Docker image by default. This app targets Indic languages elsewhere (Sarvam,
AI4Bharat), but no Malayalam/Tamil/Telugu/etc. Piper voice was independently confirmed to exist as
a published model in this dev sandbox (no outbound access to huggingface.co here) — guessing at a
voice-model filename that turns out not to exist would silently 404 at runtime, so this ships
English-only rather than a guessed mapping. Auto-falling back to it for an Indic-language customer
would otherwise silently downgrade them to an English-accented voice.

**Adding more languages**: download the `<voice>.onnx`/`<voice>.onnx.json` pair for the language
you want from https://huggingface.co/rhasspy/piper-voices into the render pipeline's
`models/piper-voices/` directory (mount as a persistent volume — see the Dockerfile's `VOLUME`
line, same convention as `assets/`/`fonts/`), then set `PIPER_VOICE_MAP_JSON` (a runtime env var,
e.g. `{"hi":"hi_IN-<voice-name>-medium"}`) to map the language code to that voice's basename. No
rebuild needed — `render-pipeline/lib/piperTts.js`'s `supportsLanguage()` checks the model file's
actual presence on disk, not just the map.

**Setup**: nothing beyond a normal render-pipeline deploy — the Piper binary and the default
English voice are downloaded at Docker build time (see the Dockerfile's `PIPER_VERSION` build arg
and its own comment on where to check for a current release tag if that URL ever 404s). `GET
/health` reports `piper_available` and `piper_voices` (the list of languages with a model actually
present on disk) so a stale/incomplete build is easy to spot before a client tries to use it.

**Not verified against a live build** — the Piper binary release URL, its exact CLI flags
(`--model`/`--output_file`, text piped via stdin), and the `rhasspy/piper-voices` model URL
pattern are implemented from the project's own published quickstart/release conventions; no
outbound access to github.com or huggingface.co release/model assets was available in the dev
sandbox this was built in. Confirm the Dockerfile's Piper steps actually succeed on your first real
build, and test a real synthesis call before enabling for a paying client.

## Direct password setting/reset (User Management, `frontend/dashboard.html` — 👥 User Management)

Team user creation previously only ever set a password directly on the new Authentik account so it
wasn't literally passwordless — the teammate always had to pick their own via an emailed invite
link (Authentik Recovery flow), or, if that flow wasn't bound yet, was handed a one-time
server-generated password as a fallback. Two things changed:

1. **Create New User now has an optional Password field.** Leave it blank to keep the exact same
   invite-link/email behavior as before. Fill it in (or click 🎲 to generate one) and
   `handleTeamCreateUser` (`worker.js`) sets that password directly on the new Authentik account and
   skips the invite-link/email step entirely — `explicitPassword:true` in the response tells
   `renderTeamCreateResult` (`dashboard.html`) to show the right message ("password set directly",
   not "no Recovery flow bound").
2. **Every profile in User Management now has a "🔑 Set / Reset Password" card** (both the account
   owner and any teammate) — `handleTeamSetPassword` (`POST /team/set-password`), sets the password
   directly on Authentik and, if a linked Chatwoot agent exists for that email, there too (same
   `PATCH /platform/api/v1/users/:id` Chatwoot Platform API call pattern `createChatwootAgent`
   already uses).

**Authorization, enforced server-side** (never trust the frontend's own `canViewCredentials` check
alone): the account owner can reset anyone on their own account, including themselves; anyone else
can only reset their own password. The target email must also actually belong to that client's
account (the owner's `authentik_email`, or a listed `team_emails` entry) — checked explicitly,
since `authentikApiFetch` runs on one shared service-account token that reaches every Authentik
user on the whole instance, not just this client's own users; skipping that check would let any
signed-in client reset an arbitrary stranger's password by guessing their email.

**Not verified against a live call**: `authentikFindUserByEmail`'s `?email=` exact-match filter on
Authentik's Core API user-list endpoint (needed because neither the "Add Existing Authentik User"
flow nor `handleTeamCreateUser` persist an Authentik user's `pk` anywhere on the CLIENTS row) is
implemented from Authentik's documented filterable-fields convention, not exercised against a live
instance in this dev sandbox. If it doesn't filter as expected, `?search=<email>` (fuzzy, documented
as always available) is the fallback, with an exact match picked out client-side.

## Generic per-product link (`frontend/ecom.html` — Ecommerce products)

The Ecommerce module already let a product override its default storefront link with a
Shopify-specific URL (`shopify_product_url`, only shown once Shopify is connected) — but a client
selling through anything else (Instagram, Amazon, a marketplace listing, a standalone landing page)
had no equivalent. **`product_link`** is a new, always-visible per-product field ("Product Link
(optional)" in the product editor) that does the same job without requiring Shopify.

`buildOrderLink` (`worker.js`) now checks, in order: `shopify_product_url` → `product_link` →
the client-wide `external_store_link` (Settings → Order Link) → the built-in
`onshope.com`/`store.html` catalog link. A per-product link (Shopify or generic) always wins over
the client-wide one, since it's more specific.

Also added: a **🔗 Copy Link** button on every product row in the Ecommerce products table
(`resolveProductLink`/`copyProductLink`, `ecom.html`) that mirrors `buildOrderLink`'s exact
priority client-side, so what a merchant copies always matches what the bot would actually send —
useful for pasting a product's link into an Instagram bio, a manual DM, or anywhere outside the
WhatsApp chat flow itself. `ECOM_CLIENT_READ_FIELDS` (`worker.js`) gained `client_slug`/
`external_store_link` so `GET /ecom/client` can expose what this needs to compute the fallback link
correctly — both already public-facing values (they ARE the storefront URL), not sensitive like a
token would be.

## Scheduled Report Builder (Reports page → 🗓️ Scheduled Reports)

A client can build one or more custom reports (`scheduled_reports`, D1 —
`migrations/0042_scheduled_reports.sql`; multiple reports per client are just multiple rows, same
convention as `re_channel_partners`/`fp_expected_dues`), pick which sections go in each, choose
Daily or Weekly delivery, and have it emailed automatically — no Cube.js or any other external BI
engine involved (see below for why).

**Why not Cube.js**: this was originally scoped to use a fork of
[cube-js/cube](https://github.com/hussainhabeebi/cube), the open-source semantic layer. Cube needs
a direct SQL database driver connection (Postgres/MySQL/Snowflake/etc.) — this app's data lives
behind NocoDB's REST API (no raw Postgres connection string exists anywhere in this codebase) and
Cloudflare D1 (SQLite, only reachable from inside the Worker). Standing Cube up for real would need
DB credentials and a new hosted service neither of which existed to build against, so — by explicit
choice, confirmed with the client — the report builder instead reuses this app's own existing
query patterns (NocoDB REST + D1), the same way every other report on this page already works.

**Sections** (`REPORT_SECTIONS`, `worker.js`) — a fixed catalog the builder's checkboxes are drawn
from, one of two shapes:
- **Genuinely new server-side computations** (Overview/Sales/Team/SaaS Ops) — these never had a
  server endpoint before (Sales/Team/Overview were client-side-only, computed from `allLeads`
  already loaded in the browser; see the Reports page's own "no new backend" note above). Direct
  NocoDB Lead queries (`reportFetchAllLeads`), mirroring `isWonLead`/`isLostLead`/`getTeamMembers`
  from dashboard.html by hand (no shared module between client and Worker code).
- **Reused existing handlers** (WhatsApp/Ecommerce/Product/SEO/Marketing) — called directly as
  plain functions, exactly the way `handleReportsProducts` already calls
  `handleShopifyAnalytics(request, env)` internally. Since a cron tick has no real browser session
  to pass through, `buildInternalReportRequest` mints a fresh signed session (`signSession`, the
  same primitive a real login uses) and builds a synthetic `Request` for these handlers to read.

**Branding**: the report header always shows `CLIENTS.client_name` — never "Leadvyne" anywhere in
the output, and the email's From display name is `"<client_name> Reports"` (the From ADDRESS stays
the platform's verified Resend domain, `RESEND_FROM_EMAIL` — a client can't verify their own domain
in Resend just for this, only the display name is theirs).

**Templates/layout** (`reportTemplateCss`) — three built-in visual templates sharing the same
markup, picked per-report: `classic` (visibly bordered/boxed sections — the literal "give borders"
ask), `modern` (left accent-bar cards, soft shadow, no hard borders), `minimal` (bare, divider-only,
maximum whitespace). One `accent_color` (a hex value, client-chosen) threads through all three —
header rule, stat numbers, table headers, and (classic only) every section's border color.

**Scheduling**: `frequency` is `daily` or `weekly` (+ `weekly_day`, 0=Sunday..6=Saturday UTC, only
used when weekly). `runScheduledReportsForAllClients` is piggybacked on the existing daily
`0 2 * * *` cron tick (same reasoning as every other daily-granularity sweep already on that tick —
see its own comment) — a report is skipped if `last_sent_at` already falls on today's UTC date, so
one extra tick in a day can never double-send.

**Routes**: `GET/POST/PATCH/DELETE /reports/scheduled` (CRUD), `POST /reports/scheduled/preview`
(renders without sending — dashboard.html opens the HTML in a new tab via a Blob URL, works for
both an already-saved report and an in-progress unsaved draft), `POST /reports/scheduled/send-now`
(manual send + updates `last_sent_at`, for testing a report before waiting on its schedule).

**Email delivery** uses the platform-level `RESEND_API_KEY`/`RESEND_FROM_EMAIL` (the same shared
key task-notify emails already use) — works out of the box for every client, no per-client Resend
account needed (unlike the Email Marketing module's bulk campaigns, which rightly stay gated behind
a client's own Resend key/domain since that's real outbound marketing volume).
