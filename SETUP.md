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
| team_emails | Long text (comma-separated additional Authentik emails with full access to this same account — see "Multi-user support" below) |
| fulfilled_addon_events | Long text (comma-separated Checkout Session ids already fulfilled — dedupes add-on delivery if Stripe redelivers a `checkout.session.completed` webhook; capped to the most recent 20) |
| last_renewal_notice_sent | Single line (ISO datetime — set by `n8n/rbi-renewal-notice.json` so each renewal only gets one backup reminder email even though the workflow runs daily; see "RBI pre-debit notification" below) |
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
similar addresses. There's no separate invite email: the owner adds a teammate's address from
**Settings → Team Members**, and the moment that person signs in via Authentik (existing account
or brand new), they land straight in the same dashboard with full access — same as the owner,
no role restrictions, no seat limit. If you want restricted roles or plan-tied seat limits later,
that logic would live in this same matching function plus per-action permission checks in the UI.

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

**How login threads through it**: the browser still does the Authentik OIDC/PKCE exchange
itself (public client, no secret) and gets a short-lived Authentik `access_token`. It hands
that to the Worker's `/session/exchange`, which verifies it against Authentik's `/userinfo`
endpoint, looks up the CLIENTS row by `authentik_email`, and issues its **own** signed session
token (HMAC, `SESSION_SIGNING_KEY` secret) valid for 24h — this avoids needing OAuth
refresh-token logic in the browser, since Authentik's access tokens are only valid a few
minutes. Every subsequent call sends that session token as `Authorization: Bearer …`.

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
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Use the **Snapshot** payload style, not
   Thin — the Worker's handler expects the full object inline on `event.data.object`.
5. **Customer emails** (Settings → Customer emails) — turn on "Successful payments" and "Failed
   payments" so customers get Stripe's own receipt/dunning emails. Also relevant to the RBI
   pre-debit notice below.

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

**2. Backup reminder layer (defense-in-depth / audit trail)** — `n8n/rbi-renewal-notice.json`
(import it manually into n8n and set its SMTP credential, same as `n8n/notifications.json` — see
that workflow's own setup for the SMTP credential pattern) is a second, independent reminder that
doesn't depend on Stripe's own notification actually firing:
- Runs daily, queries CLIENTS for `plan_status` in `active`/`trialing` where `plan_renews_at`
  falls 24-48h out, and emails `notification_email` a plain-language renewal notice (plan name,
  amount context, renewal date).
- Dedupes via a new `last_renewal_notice_sent` field on CLIENTS (see schema table above) so each
  renewal only sends one reminder even though the workflow runs daily and a renewal date can fall
  inside the 24-48h window on more than one run.
- This is a **backup**, not a replacement — it doesn't carry Stripe's own e-mandate/AFA
  authentication mechanics, it's a plain notice. Treat step 1 as the actual compliance mechanism
  and this as an audit-trail safety net on top of it.

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
7. **Company profile** — `POST /billing/company-profile` saves `client_name`/`company_address`
   to the CLIENTS row and, if a `stripe_customer_id` already exists, best-effort pushes the same
   name/address to the Stripe Customer so it shows correctly on future invoices/receipts.
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
- **Template Broadcast lists and sends go straight through Meta's Graph API** (`GET /wa/templates`,
  `POST /wa/send-template`), the same route the Prospects module already uses — **not** Chatwoot's
  inbox-scoped `whatsapp_templates` endpoint, which one production client's account 404'd on even
  with a confirmed-correct `chatwoot_account_id`/`chatwoot_inbox_id`/token (matched Chatwoot's own
  UI) and templates visible in Chatwoot's dashboard. This also fixes the underlying reason a
  template send is needed at all: leads outside the 24h session window require an approved
  template, and that has nothing to do with which system lists/sends it — Graph API direct works
  regardless of window, and drops the dependency on Chatwoot's template sync entirely. Requires
  `wa_phone_id`/`wa_token`/`waba_id` on the client record; if missing, the page shows a "Connect it
  in Settings → Channels" link (`dashboard.html?channels=1` deep-links straight to that tab) instead
  of a separate credential form — Channels' existing Meta Embedded Signup flow already collects and
  stores these, so there's nothing new to build there.
- The **Manage Templates** tab (creating new templates) still submits via the Chatwoot-scoped
  `POST /broadcast/templates` route — not yet switched to Graph API direct. Known follow-up if that
  same client also can't create templates from Chatwoot; not reported broken as of this writing.

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
