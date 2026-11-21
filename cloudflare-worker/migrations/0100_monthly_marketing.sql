-- Monthly Marketing module (Campaigns → 📅 Monthly Marketing, broadcast.html). A client assigns
-- approved WhatsApp templates to a lead category (ServiceCategory/ProductCategory) or to a lead tag
-- (Tags, from the Leads panel); runMonthlyMarketingForAllClients (worker.js) then sends one template
-- per month to each Hot/Warm, non-won lead matching the rule, straight through Meta's Graph API.
-- Nothing is sent for a client until they save a rule with a frequency AND at least one template
-- AND turn it on — no rows here means no behaviour change for any existing client.
CREATE TABLE IF NOT EXISTS monthly_marketing_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  rule_type TEXT NOT NULL,                  -- 'category' | 'tag'
  match_value TEXT NOT NULL,                -- category name / tag as the client typed it
  match_key TEXT NOT NULL,                  -- lower(trim(match_value)), for uniqueness + matching
  frequency TEXT,                           -- NULL = off | 'monthly'
  day_of_month INTEGER NOT NULL DEFAULT 1,  -- 1-31; clamped to the month's last day when larger
  templates_json TEXT NOT NULL DEFAULT '[]',-- ordered [{name, language, body_vars}]; each lead gets the first one it hasn't received yet
  active INTEGER NOT NULL DEFAULT 0,
  last_full_scan_at TEXT,                   -- last tick that went through every lead for this rule without hitting the send budget
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mm_rules_unique ON monthly_marketing_rules(client_id, rule_type, match_key);
CREATE INDEX IF NOT EXISTS idx_mm_rules_active ON monthly_marketing_rules(active, client_id);

-- One row per send attempt. A row is reserved as 'pending' BEFORE the Graph API call, so the unique
-- indexes below are what actually guarantee no duplicates — a second cron tick, a retry, or two
-- lead records sharing one phone number all hit the index and are ignored instead of sending again.
-- Only an explicit Meta error flips a row to 'failed' (freeing its slot for a retry); a network
-- error leaves it 'pending', since Meta may already have delivered it.
CREATE TABLE IF NOT EXISTS monthly_marketing_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  rule_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  phone TEXT NOT NULL,                      -- digits only
  template_name TEXT NOT NULL,
  template_language TEXT,
  month_key TEXT NOT NULL,                  -- 'YYYY-MM' in the client's timezone
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  wa_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
-- At most one monthly message per lead (and per phone number) per month, across all rules.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mm_sends_lead_month ON monthly_marketing_sends(client_id, lead_id, month_key) WHERE status<>'failed';
CREATE UNIQUE INDEX IF NOT EXISTS idx_mm_sends_phone_month ON monthly_marketing_sends(client_id, phone, month_key) WHERE status<>'failed';
-- The same template never goes to the same lead (or phone number) twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mm_sends_lead_template ON monthly_marketing_sends(client_id, lead_id, template_name) WHERE status<>'failed';
CREATE UNIQUE INDEX IF NOT EXISTS idx_mm_sends_phone_template ON monthly_marketing_sends(client_id, phone, template_name) WHERE status<>'failed';
CREATE INDEX IF NOT EXISTS idx_mm_sends_client_month ON monthly_marketing_sends(client_id, month_key);
