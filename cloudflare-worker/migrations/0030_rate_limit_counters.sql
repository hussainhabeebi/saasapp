-- App-level rate limiting for public/unauthenticated routes (SETUP.md "DDoS protection") —
-- fixed-window per-IP counters for the handful of endpoints an attacker can hit without a
-- session token (login exchange, admin login, public storefront/booking writes). Endpoints that
-- already require a signed session, plus every external webhook (Shopify/Stripe/WhatsApp/etc,
-- which already verify their own HMAC/signature before doing any work), are deliberately not
-- routed through this table — see the RATE_LIMIT_RULES comment in worker.js.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  rl_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

-- Lets the daily cron's cleanup sweep (cleanupRateLimitCounters in worker.js) find expired rows
-- without a full table scan as this grows.
CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_expires ON rate_limit_counters(expires_at);
