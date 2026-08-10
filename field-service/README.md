# Field Service module

A standalone field-service SaaS (Jobber/Housecall Pro-style: booking, job status pipeline, GPS
check-in/out, quotes→invoices, recurring billing, staff roles, inventory) built as its **own**
Cloudflare Worker + D1 database + static frontend. It does not import from, get imported by, or
share a database with the existing platform in `../cloudflare-worker` and `../frontend` — it can
be deployed, changed, or torn down independently.

What it deliberately does **not** share with the rest of the repo:
- Its own D1 database (`leadvyne-field-service-d1`), own migrations.
- Its own auth: JWT (HS256) + PBKDF2 password hashing + lockout, no Authentik/NocoDB dependency.
- Its own `SESSION_SIGNING_KEY` secret — never reuse the main platform's.
- Its own Worker deployment (`leadvyne-field-service-api`) and cron trigger.

## Contents
```
worker.js                     ← the entire API (auth, jobs, quotes, invoices, GPS, inventory, portal)
wrangler.toml                 ← Worker config — own D1 binding, own cron
migrations/0001_init.sql      ← full schema
frontend/owner.html           ← business owner/manager dashboard
frontend/staff.html           ← field staff PWA (job list, GPS check-in/out, status updates)
frontend/customer.html        ← customer self-service portal (magic-link, no login)
frontend/manifest.json        ← PWA manifest, scoped to staff.html
frontend/sw.js                ← PWA service worker (staff app shell caching)
```

## Data model
`tenants` → `users` (role: owner/manager/staff) → `customers` → `jobs` → `job_status_history` /
`gps_checkins` / `job_parts_used`. Billing: `quotes` (+ `quote_items`) → accept → `invoices`
(+ `invoice_items`) → `payments`. `recurring_plans` auto-generates invoices via the daily cron.
Every table carries `tenant_id`; every authenticated route scopes queries by the tenant_id
embedded in the caller's JWT, never a client-supplied one.

## Roles
- **staff**: sees only jobs assigned to them (`/api/jobs/mine`), can set status to
  en_route/in_progress/completed, GPS check-in/out, log parts used.
- **manager**: everything staff can do, plus customers/jobs/quotes/invoices/inventory/recurring
  plans, CSV export/import, staff list (cannot create/edit owner or manager accounts).
- **owner**: everything, plus tenant settings (tax rate, cancellation policy), creating
  manager/owner accounts, deactivating staff.

## Quick start
1. `wrangler d1 create leadvyne-field-service-d1`, paste the `database_id` into `wrangler.toml`.
2. `wrangler d1 migrations apply leadvyne-field-service-d1 --remote`
3. `wrangler secret put SESSION_SIGNING_KEY` (e.g. `openssl rand -hex 32`).
4. Edit `ALLOWED_ORIGINS` in `wrangler.toml` to the domain(s) you'll serve `frontend/` from.
5. `wrangler deploy`
6. Serve `frontend/` as static files (any static host / nginx / Coolify — same pattern as
   `../frontend`'s `Dockerfile`+`nginx.conf`, just pointed at this folder instead) and set the
   `API_BASE` constant at the top of each HTML file's `<script>` to your deployed Worker URL.
7. Open `owner.html` → "Create your business account" to sign up the first tenant.

## What's real vs. stubbed in this first pass
Real and working: multi-tenant core, JWT auth with PBKDF2 + lockout, self-serve signup, booking/
job status pipeline, GPS check-in/out, cancellation fees, quote→invoice conversion, VAT/GST-rate
invoicing (single-rate, not full GST slab/CGST-SGST splitting), cash/card/bank payment recording,
recurring billing cron, parts/inventory tracking, CSV export + bulk customer CSV import, customer
self-service portal (magic-link token, view/reschedule/cancel bookings).

Explicitly stubbed, documented in code, safe to extend later without redesigning anything:
- **Online payment collection** — `POST /api/portal/:token/invoices/:id/pay-intent` returns
  `{status:'not_configured'}` instead of a fake charge. Wire in a real gateway (Stripe/PayTabs/
  Razorpay) there when one is chosen.
- **PDF quotes/invoices** — the API returns structured JSON; render it to PDF client-side
  (owner.html / customer.html) or add a `/pdf` route once a template is designed. Cloudflare
  Workers can't run a headless-Chrome PDF renderer, so this needs either a client-side lib or an
  external render service (the same pattern `../render-pipeline` uses for video).
- **Custom domain / subdomain-per-tenant routing** — `tenants.subdomain` / `custom_domain` columns
  exist and `PATCH /api/tenant` can set them, but the frontend currently resolves the tenant from
  the logged-in user's JWT, not the request's Host header. Add that resolution + DNS/nginx
  `server_name` entries (same pattern as the main platform's `onshope.com` handling) if per-tenant
  domains are needed.
- **WhatsApp bot / AI photo-to-quote / missed-call follow-up** — none of the "unique innovations"
  are built here; this module is the table-stakes field-service core. They're a separate, later
  effort (and would likely reuse the main platform's existing Conversation Engine rather than
  duplicating it here).

## Frontend ↔ API contract
Every `frontend/*.html` file is a single static page with a `<script>` block that calls this
Worker via `fetch`. Auth: `owner.html`/`staff.html` store the JWT from `/api/auth/login` in
`localStorage` and send `Authorization: Bearer <token>` on every call. `customer.html` needs no
login — it's addressed as `customer.html?t=<portal_token>` (the token lives on each `customers`
row; copy it from a customer's detail view in `owner.html` until a WhatsApp/SMS/email delivery
step is added).
