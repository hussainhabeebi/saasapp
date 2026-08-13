-- Projects module (SETUP.md "Projects module") — standalone tool at frontend/projects.html, tied
-- to the same Leadvyne login/session as the CRM (same client_id, same Authentik account) but its
-- own tables, not a CRM feature. Phase 1 slice: Projects + Tasks with a fixed schema (title,
-- status, priority, assignee, dates), one shared D1 table each, client_id-scoped — same shape as
-- Recruitment/Hospitality/SaaS Ops.
CREATE TABLE IF NOT EXISTS pm_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT NOT NULL DEFAULT '#0D9C93',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_projects_client ON pm_projects(client_id);

-- status: todo|in_progress|review|done (kanban columns). priority: low|medium|high|urgent.
-- position is a float, not an integer — reordering within/between kanban columns writes a value
-- between its two new neighbors (e.g. 1.5 between 1 and 2) instead of renumbering every row on
-- every drag.
CREATE TABLE IF NOT EXISTS pm_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee_email TEXT,
  start_date TEXT,
  due_date TEXT,
  position REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_tasks_client ON pm_tasks(client_id);
CREATE INDEX IF NOT EXISTS idx_pm_tasks_project ON pm_tasks(client_id, project_id);
