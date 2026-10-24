-- Links each support ticket to its corresponding pm_tasks row so ticket status changes
-- propagate to the Projects board and messages appear in the CRM.
ALTER TABLE support_tickets ADD COLUMN task_id INTEGER;
