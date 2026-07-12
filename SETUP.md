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
| plan_cancel_at_period_end | Single line ("Yes"/"No" — customer canceled from the Portal but keeps access until `plan_renews_at`) |
| company_address | Long text (billing address, pushed to the Stripe Customer for invoices) |
| billing_email | Single line (**required before a Stripe Customer is ever created** — `ensureStripeCustomer` refuses to create one without it; both `handleBillingCheckoutSubscription` and `handleBillingCheckoutAddon` return a 400 telling the customer to set it first, rather than silently falling back to `authentik_email`, since the login address is sometimes a shared/ops account, not who should receive billing mail. Once a `stripe_customer_id` already exists this field can still be edited/updated freely — the "required" check only guards *creating* the Stripe account in the first place) |
| team_emails | Long text (comma-separated additional Authentik emails with full access to this same account — see "Multi-user support" below) |
| team_chatwoot_users | Long text (JSON, `{email: chatwoot_user_id}` — per-teammate Chatwoot Platform user ids, populated by User Management → Create New User — see "Matching Chatwoot agent" below) |
| team_names | Long text (JSON, `{email: name}` — display names for team_emails, populated by User Management → Create New User — see "Agents = Team Members = Users" below; the now-unused `agents` field it replaced was a plain newline-separated name list) |
| business_policies | Long text (JSON, `{refund, delivery, cancellation}` — structured objection-handling policy text, Settings → Trust & Policies — see "Trust Signals & grounded objection-handling" below) |
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
  n8n has none). Body: `{client_id, phone, name?, sku?}`. Builds the same storefront link a
  product card's own "Order on WhatsApp" button already uses (`onshope.com/<slug>` if the client
  has one, else `store.html?client=<id>`, with `&sku=` for a specific product), sends it directly
  via Meta's Graph API (bypassing Chatwoot, same pattern as `handleWaSend`), and **always** logs a
  `pending`-status row in the client's ecom orders table — even if the WhatsApp send itself fails
  (e.g. the customer is outside Meta's 24h free-form-message window), so "order intent" leaves a
  paper trail regardless. Returns `{ok, link, order_id, whatsapp_sent, whatsapp_error?}`. This is
  the route the n8n bot should call the moment it decides a customer wants to buy something.
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
per-conversation trackable one, and nothing here makes the bot actually create an order row when a
customer says yes — that half still needs a real call to `/ecom/order-link` (or a human clicking
"Push to Order"), since a trackable link and a NocoDB row both require a server-side write that
prompt content alone can't perform.

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
