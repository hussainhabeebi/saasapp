-- Home page KPI customization (SETUP.md "Home page (industry KPIs, Cloudflare Pages)") — one row
-- per client, storing which KPI tiles they've chosen to show on the new Home page and in what
-- order. Account-level (not per-teammate), matching how every other account-wide preference in
-- this app is stored (one CLIENTS row) — the KPI values themselves still come straight out of
-- NocoDB's Leads table via the existing /nocodb passthrough, this table only remembers the
-- picker's on/off + order state, which has no other home.
CREATE TABLE IF NOT EXISTS home_kpi_prefs (
  client_id INTEGER PRIMARY KEY,
  kpi_keys TEXT NOT NULL, -- JSON array of KPI keys, in display order, e.g. ["booked","active","hot_leads"]
  updated_at TEXT NOT NULL
);
