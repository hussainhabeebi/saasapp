-- Disable POOMAS API for all clients that currently have it enabled.
-- Search continues to work via live_travel_suppliers (which is not changed here)
-- and via the /live-travel/poomas/search endpoint (which no longer requires enabled=1).
UPDATE live_travel_poomas_settings SET enabled=0, updated_at=datetime('now') WHERE enabled=1;
