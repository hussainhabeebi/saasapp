-- Marketing Studio module — persist the Auto-edit step's toggle selections (silence-cut, auto-zoom,
-- background music, denoise, chroma key, auto-reframe, beat-sync, speed) on the project itself,
-- instead of only living transiently in the browser tab (previously lost on reload/reopen). Also
-- what lets the Editor auto-save these on every change ("apply without clicking Save") while still
-- being freely re-editable afterward ("amend"), same edit-in-place shape as cues_json/captions_json.
ALTER TABLE marketing_projects ADD COLUMN autoedit_options_json TEXT;
