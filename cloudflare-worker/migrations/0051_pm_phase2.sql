-- Projects module Phase 2 (SETUP.md "Projects module") — real Gantt dependencies/critical path,
-- time tracking/job costing, an automation engine, and the IT module (Sprints, bug tracker, Git
-- links) on top of the Phase 1 core (0050_pm_projects_tasks.sql).

-- Job costing needs a budget to measure against, and a default rate so a time entry doesn't have
-- to specify one every time.
ALTER TABLE pm_projects ADD COLUMN budget_amount REAL;
ALTER TABLE pm_projects ADD COLUMN budget_currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE pm_projects ADD COLUMN default_hourly_rate REAL;

-- item_type splits Tasks from Bugs without a parallel table — a bug IS a task with extra fields,
-- and keeping one table means the Board/Table/Timeline views already built for tasks work for
-- bugs with no separate view layer. severity is bug-only (blank for item_type='task'). sprint_id/
-- story_points are the Scrum fields; link_url/link_label is a manually-pasted PR/commit link (see
-- the PM module's own note on why this isn't a live GitHub API integration). done_at is set the
-- moment status transitions to 'done' and cleared if it's reopened — updated_at changes on every
-- edit, so it can't stand in for "when did this actually finish" the way burndown/velocity need.
ALTER TABLE pm_tasks ADD COLUMN item_type TEXT NOT NULL DEFAULT 'task';
ALTER TABLE pm_tasks ADD COLUMN severity TEXT;
ALTER TABLE pm_tasks ADD COLUMN story_points INTEGER;
ALTER TABLE pm_tasks ADD COLUMN sprint_id INTEGER;
ALTER TABLE pm_tasks ADD COLUMN link_url TEXT;
ALTER TABLE pm_tasks ADD COLUMN link_label TEXT;
ALTER TABLE pm_tasks ADD COLUMN done_at TEXT;
CREATE INDEX IF NOT EXISTS idx_pm_tasks_sprint ON pm_tasks(client_id, sprint_id);

-- Finish-to-start dependencies with optional lag (days). Critical path itself is computed
-- client-side in projects.html (a standard forward/backward CPM pass over data already loaded in
-- the browser) rather than a new heavy server endpoint — this table is just the edge list.
CREATE TABLE IF NOT EXISTS pm_task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  predecessor_id INTEGER NOT NULL,
  successor_id INTEGER NOT NULL,
  lag_days INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(predecessor_id, successor_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_deps_client ON pm_task_dependencies(client_id);
CREATE INDEX IF NOT EXISTS idx_pm_deps_project ON pm_task_dependencies(client_id, project_id);

CREATE TABLE IF NOT EXISTS pm_time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  user_email TEXT,
  entry_date TEXT NOT NULL,
  hours REAL NOT NULL DEFAULT 0,
  note TEXT,
  billable INTEGER NOT NULL DEFAULT 1,
  hourly_rate REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_time_client ON pm_time_entries(client_id);
CREATE INDEX IF NOT EXISTS idx_pm_time_project ON pm_time_entries(client_id, project_id);
CREATE INDEX IF NOT EXISTS idx_pm_time_task ON pm_time_entries(client_id, task_id);

CREATE TABLE IF NOT EXISTS pm_sprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_sprints_client ON pm_sprints(client_id);
CREATE INDEX IF NOT EXISTS idx_pm_sprints_project ON pm_sprints(client_id, project_id);

-- trigger_config/action_config are small JSON blobs (e.g. {"status":"done"} / {"to_email":"..."})
-- — see the "PM automation engine" note in worker.js for the fixed catalog of trigger/action
-- types this evaluates. A curated catalog, not a generic condition builder, by design.
CREATE TABLE IF NOT EXISTS pm_automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_config TEXT,
  action_type TEXT NOT NULL,
  action_config TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_automations_client ON pm_automations(client_id);
CREATE INDEX IF NOT EXISTS idx_pm_automations_project ON pm_automations(client_id, project_id);
