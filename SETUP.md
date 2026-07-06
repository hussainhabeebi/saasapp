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

### LEADS table additions (for the Quotation module's sent log)
Two more columns on the **LEADS** table (not CLIENTS) so sent quotations show up in the
Quotation tab's "Sent Quotations" report:

| Field | Type |
|---|---|
| QuoteSentAt | Single line (ISO datetime) |
| QuoteSentTotal | Single line |

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

**Known gap**: `broadcast.html` and `ecom.html` still embed the master NocoDB token directly and
are **not yet migrated** to this Worker — same exposure as before on those two pages
specifically. `dashboard.html`, `index.html`, and `admin.html` are fully migrated.

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

### Plans are shown via a Stripe Pricing Table
Plan selection uses a **Stripe Pricing Table** (Dashboard → Product catalog → Pricing tables),
embedded directly in the Billing page:
```html
<script async src="https://js.stripe.com/v3/pricing-table.js"></script>
<stripe-pricing-table pricing-table-id="..." publishable-key="pk_..." client-reference-id="..."></stripe-pricing-table>
```
This is Dashboard-managed on purpose — add a plan, change its price or copy, all from Stripe,
no code change or redeploy. It creates its own Checkout Session client-side using only the
**publishable key** (safe to expose in the browser, unlike the secret key); the Worker never
sees that request at all. `client-reference-id` is set to the logged-in client's row `Id` —
that's what the webhook reads on `checkout.session.completed` to know which CLIENTS row to link.

If you want per-currency manual selection (e.g. an explicit INR/AED toggle) rather than Stripe's
IP-based auto-detected currency, create **two** Pricing Tables (one per currency's Products) and
swap which one the Billing page renders based on a currency toggle — same `client-reference-id`
attribute either way.

### Multi-currency add-ons
Add-ons (WhatsApp credits, voice) are **not** part of the Pricing Table — Pricing Tables are
subscription-only, so these stay as our own one-time Checkout (`mode=payment`). If you sell them
in more than one currency, create a **separate Price object per currency** under the same
Product (Stripe's `currency_options` on a single Price is a different, auto-detected mechanism
and isn't what's implemented here). `CONFIG.BILLING_ADDONS` in `dashboard.html` is keyed
`{id, name, prices:{INR:{price_id,display}, AED:{price_id,display}, …}}` — the Billing page's
currency toggle (now scoped to just the Add-ons section) picks the matching Price ID.

### Stripe Dashboard setup
1. **Pricing Table** for plans (Product catalog → Pricing tables → create) — add your recurring
   Prices there; set each Price's **nickname** to the human-readable plan name (e.g. "Growth") —
   the webhook reads this into `plan_name`. Optionally set metadata `message_limit` (e.g. `1000`)
   if you want a quota shown in the usage dashboard later. Copy the resulting `prctbl_...` ID and
   your publishable key (`pk_...`) into `dashboard.html`'s `CONFIG.STRIPE_PRICING_TABLE_ID` /
   `CONFIG.STRIPE_PUBLISHABLE_KEY`.
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
   payments" so customers get Stripe's own receipt/dunning emails. This is also the mechanism
   behind the RBI pre-debit notice for India-issued cards — Stripe/the card issuer sends it
   automatically as part of the Subscriptions e-mandate flow; nothing to build here.

### Worker config
| Secret/var | What it is |
|---|---|
| `STRIPE_SECRET_KEY` (secret) | Your Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` (secret) | Signing secret for the `/billing/webhook` endpoint |
| `STRIPE_ADDON_PRICE_IDS` (var, comma list) | Allow-list of one-time add-on Price IDs |
| `APP_BASE_URL` (var) | Dashboard URL Stripe redirects back to after Checkout/Portal (e.g. `https://app.leadvyne.com/dashboard.html`) |

`STRIPE_PLAN_PRICE_IDS` and the `POST /billing/checkout-subscription` route still exist in the
Worker as a fallback/manual path, but nothing in the UI calls them anymore now that plans go
through the Pricing Table — safe to ignore, or remove later if you're sure you won't need a
custom (non-Pricing-Table) subscribe flow.

### Confirming a subscription: pull-based, not just the webhook
The webhook's `client_reference_id`/`stripe_subscription_id` correlation (below) can fail to link
up for reasons outside the Worker's control — the Pricing Table's "after payment" redirect not
configured, a direct/preview Stripe link bypassing `dashboard.html` entirely, etc. Rather than
only depending on that, there are two **pull-based** routes that use the browser's own
authenticated session (so there's no correlation to get wrong — we already know which CLIENTS row
this is):
- `GET /billing/confirm-session?session_id=cs_...` — fetches that specific Checkout Session from
  Stripe and syncs it onto the *currently logged-in* CLIENTS row directly. Called automatically
  when the Billing page loads with both `?billing=success` and `?session_id=...` in the URL — set
  your Pricing Table's "after payment" redirect (Dashboard → Product catalog → Pricing tables →
  Edit → Payment page settings) to
  `https://app.leadvyne.com/dashboard.html?billing=success&session_id={CHECKOUT_SESSION_ID}`
  (Stripe substitutes that placeholder itself).
- `GET /billing/sync-now` — a manual "Sync Subscription Now" button on the Billing page. Looks up
  the Stripe Customer by the account's own email(s) (`authentik_email`/`team_emails`) if
  `stripe_customer_id` isn't set yet, then pulls whatever subscription exists for that customer.
  Useful any time a checkout completed on Stripe's side but hasn't shown up here — including
  retroactively fixing an account that got stuck before this existed, no need to redo the purchase.

### Flow
1. **Subscribe** — the Pricing Table embed creates the Checkout Session itself, client-side,
   entirely outside the Worker.
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
     resolves the CLIENTS row by `stripe_subscription_id` (Pricing Table subscriptions have no
     `metadata.client_id`, only the Checkout Session had `client_reference_id`).
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
