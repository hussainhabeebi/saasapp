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
| DealValue | Number (manual — the dashboard's only input into deal size; the engine never sets this, since it has no way to know it) |
| DealCurrency | Single line (defaults from the client's `deal_currency` on lead creation; editable per lead) |
| WinProbability | Number, 0-100 (auto-suggested by the engine from stage progress + lead score on every turn; stops auto-updating once `WinProbabilityManual` is set to "Yes" so a rep's manual call is never silently overwritten) |
| WinProbabilityManual | Single line ("Yes"/"No" — set by the dashboard when a rep manually edits `WinProbability`) |
| HandoverAt | Single line (ISO datetime — stamped the moment a lead first enters `human_handover`; powers the SLA-breach alert and an in-dashboard "waiting Xm" badge) |
| SlaAlerted | Single line ("Yes"/"No" — dedupe flag so `n8n/notifications.json` only fires one SLA-breach alert per handover, reset by the engine each time a lead re-enters `human_handover`) |
| HandoverOutcome | Single line (`Resolved-Won`/`Released`/`Lost`/`No-response` — set only when a rep clicks "Mark Done" on the Human Deals page, `removeHumanDeal()` in `dashboard.html`. Nothing else writes this; a lead handed over before this feature existed simply has it blank. Drives the Human Deals Stage transition (`HD_OUTCOME_STAGE`: Won→`won`, everything else→`new`/`lost`) and the Team page's Funnel Analytics "Handover Win Rate" stat — see "Human Deals page" below.) |

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
The Worker's `/session/exchange` won't find a matching CLIENTS row (nobody's created one yet)
— instead of a dead-end error, `dashboard.html` immediately calls the onboard workflow itself
with a business name guessed from the email's local part (e.g. `jane.doe@x.com` → "Jane Doe"),
`industry: 'general'`, and `authentik_email` set — then retries `/session/exchange` with the
same (still-valid) Authentik access token and logs them straight into a fresh dashboard. No
form, no admin step, no second Authentik trip.

Chatwoot isn't connected yet at this point (Authentik has no way to collect that). The new
client fills it in themselves from **Settings → Chatwoot Webhook**, which now has all four
fields (`chatwoot_base`, `chatwoot_account_id`, `chatwoot_inbox_id`, `chatwoot_token`) —
previously only the base URL was editable there, everything else was signup-wizard-only.

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
(session-gated) calls Authentik's own Core API — `POST /api/v3/core/users/` to create the account
(`username`/`email`/`name`/`is_active`), then `POST /api/v3/core/users/{id}/set_password/` to set
the password — using a service-account API token, `AUTHENTIK_API_TOKEN` (a new Worker secret, see
"Deploy" below). The password is set directly on the Authentik user; it's never written to
NocoDB or logged by this Worker. If `set_password` fails after the user was created, the Worker
best-effort deletes the just-created user rather than leaving a passwordless, unreachable account
behind. On success, the frontend appends the new email to `team_emails` the same way the existing
"add by email" flow already does — no separate Worker-side write, reusing `patchClient()`.
**Authentik token permissions needed**: `authentik_core.add_user` and
`authentik_core.reset_user_password` (a superuser token also works, simplest for a self-hosted
single-tenant Authentik instance where this Worker is the only caller of the Admin API). Create
it under **Directory → Tokens** (or a dedicated service account) in Authentik.

**Matching Chatwoot agent (same request, best-effort):** if the client already has Chatwoot
connected (`chatwoot_account_id` set — see "Channels module"), `handleTeamCreateUser` also calls
`createChatwootAgent()`, which reuses `chatwootPlatformFetch` (the same Platform API helper
`handleChannelsCreateAccount`/`handleChannelsChatwootSso` already use) to: create a Chatwoot
Platform user with the *same* name/email/password, link them to the client's existing account via
`POST /platform/api/v1/accounts/{id}/account_users` with `role:'agent'` (not `'administrator'` —
that role is reserved for the account owner's own Chatwoot user), and generate a one-time SSO
login link via `POST /platform/api/v1/users/{id}/login`. None of this can fail the overall
`/team/create-user` request — Chatwoot may not be connected yet, or the email may already exist as
a Chatwoot Platform user; either way the Authentik/dashboard account is still created and the
response just carries `chatwoot:{ok:false, error}` instead. On success the frontend shows the new
teammate's email/password plus two links: the one-time "Log in to Chatwoot now" SSO link, and a
durable direct link to the connected inbox (`{chatwoot_base}/app/accounts/{account_id}/inbox/{inbox_id}`)
for viewing conversation detail.

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
3. **Add Another Inbox** — `POST /channels/inbox` creates a Website widget, Email, SMS (Twilio),
   Telegram, LINE, or API inbox on the same Chatwoot account — the same channel types Chatwoot's
   own generic inbox API supports (`allowed_channel_types` minus `whatsapp`, which has its own
   OAuth route above). Multiple of these are allowed per account (unlike WhatsApp). They aren't
   written back to CLIENTS (nothing in the bot engine references them) — the response links
   straight to that inbox's settings page in Chatwoot for any manual finishing touches (widget
   styling, IMAP for email, etc).
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
(order/fulfillment/checkout webhooks → WhatsApp templates straight through Meta's Graph API),
one-click OAuth connect from **Settings → Integrations** (`dashboard.html`), with the
notification template setup and send log living in the Ecommerce module's new **Shopify** tab
(`ecom.html`).

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

**New NocoDB table** `shopify_checkouts` (abandoned-cart tracking) — fields: `client_id`,
`checkout_token`, `phone`, `customer_name`, `cart_summary`, `total`, `currency`, `recovery_url`,
`created_at`, `nudge_sent` (Yes/No), `completed` (Yes/No). Paste its table id into
`SHOPIFY_CHECKOUTS_TABLE` in `worker.js` (same pattern as `EMAIL_CAMPAIGNS_TABLE` above it).

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
3. **Notifications** — set up per-event WhatsApp templates in the Ecommerce module's Shopify tab
   (`GET /ecom/wa-templates` pulls approved templates straight from Meta's Graph API — no n8n
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

**New tab: 🔁 Follow-ups** — shows leads currently mid-sequence in either of the two existing
automated systems: the classic `followup_messages` sequence (`Follow up 1/2/3` flags, up to
`followup_count` steps) and the recovery ladder (`recovery_stage`/`recovery_done`, driven by
`backend/recovery.js`). A "Send Next Now" button gives a rep a manual override — **classic
sequence only**; the recovery ladder is shown read-only since it's a separate automation with its
own escalation timing that a one-off manual send would desync. New Worker route: `POST
/broadcast/followup-send` (`{lead_id}`) — sends the next unconfigured classic step via Chatwoot
and marks the corresponding `Follow up N` field, reusing the same message templates the automated
`followup-template.json` workflow already uses.

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
- Uses the same `NOCODB_TOKEN`/`CLIENTS_TABLE` as `nba.js`; no new credentials needed.

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

### Schema — one new pair of fields on the Clients table (`mxl33bg4wi70fqj`)
- `meta_pixel_id` (Single line text) — the Meta Pixel/Dataset ID from Events Manager.
- `meta_capi_token` (Single line text) — a Conversions API access token generated for that Pixel
  (Events Manager → Data Sources → Pixel → Settings → Conversions API → Generate Access Token).
  A true secret, like `resend_api_key`: stripped by `safeClient()` so it never reaches the
  browser, and only ever written server-side via `/meta/capi/config` — never through the generic
  `/nocodb/` passthrough the dashboard uses for its own Clients row.

### Worker routes (`cloudflare-worker/worker.js`)
- `POST /meta/capi/config` — session-gated, writes `meta_pixel_id`/`meta_capi_token` (token only
  if a non-empty value was submitted — same "leave blank to keep the current value" pattern as
  `/email/client`'s `resend_api_key`).
- `GET /meta/capi/status` — session-gated, returns `{connected, pixel_id}` only — never the token.
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

**Voice-to-voice replies (Sarvam AI, `SARVAM_API_KEY`):** for clients with the Integrations →
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
  size, category, stock) as context, with the photo attached via `engineSendChatwootImageReply` —
  no link, no mention of ordering beyond what the model naturally includes. Originally a fixed
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
- **"Mark Done" outcome flow** (`openHdRemoveModal()`/`removeHumanDeal()`) — tags the lead with
  `HandoverOutcome` (see CLIENTS/LEADS field tables above) and clears `Handover`/`HandoverAt`/
  `SlaAlerted` so it drops out of the queue and stale SLA state doesn't linger. `HD_OUTCOME_STAGE`
  maps the outcome to a `Stage`: Won→`won` (reusing the same generic terminal value already
  checked in a few places in this file, e.g. `renderHome`'s conversion counts), everything else→
  `new`/`lost`.
- Nav badge (`dnHdBadge`/`bnHdBadge`) lights up with the current SLA-breach count, computed on
  every Home render (`updateHdBadge()`), not just when the tab is open.

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

