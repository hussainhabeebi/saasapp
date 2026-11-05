-- User Management (team-admin.js). Also created lazily by the Worker (tmEnsureSchema), so applying
-- this is optional.
-- team_member_meta: everyone added through User Management, with their status (pending / active /
-- deactivated / removed) and dates. Access itself still comes only from CLIENTS.team_emails; this
-- record is what lets a sign-in tell a removed or half-created teammate apart from a brand-new
-- signup, so they are never given an empty account of their own.
CREATE TABLE IF NOT EXISTS team_member_meta (
  client_id      INTEGER NOT NULL,
  email          TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending',
  invite_kind    TEXT,
  invite_id      TEXT,
  created_login  INTEGER NOT NULL DEFAULT 0,
  authentik_pk   TEXT,
  name           TEXT,
  invited_by     TEXT,
  invited_at     TEXT,
  expires_at     TEXT,
  activated_at   TEXT,
  last_login_at  TEXT,
  deactivated_at TEXT,
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (client_id, email)
);
CREATE INDEX IF NOT EXISTS idx_team_member_meta_email ON team_member_meta (email);
-- The User Management activity log.
CREATE TABLE IF NOT EXISTS team_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    INTEGER NOT NULL,
  actor        TEXT,
  action       TEXT    NOT NULL,
  target       TEXT,
  details_json TEXT,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_audit_client ON team_audit (client_id, id);
