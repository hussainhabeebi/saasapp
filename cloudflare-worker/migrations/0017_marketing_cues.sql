-- Marketing Studio module — B-Roll/SFX/VFX cue suggestions (SETUP.md "Marketing Studio module —
-- Auto-Edit Templates & Cue Suggestions"). Suggested cue points (where to drop in B-roll, an SFX
-- hit, or a simple VFX), derived from the transcript at zero marginal cost (a static
-- keyword→cue-type dictionary, no external API call — see marketingSuggestCuesHeuristic in
-- worker.js) and editable/acceptable per-cue before render, same edit-before-use shape as
-- captions_json.
ALTER TABLE marketing_projects ADD COLUMN cues_json TEXT;
