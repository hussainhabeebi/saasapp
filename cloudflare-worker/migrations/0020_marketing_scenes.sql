-- Marketing Studio module — real scene/shot-cut detection (SETUP.md "Marketing Studio module —
-- Scene detection & per-scene editing"). One row's detected scene boundaries
-- ([{start,end}, ...], seconds, in the uploaded video's original timebase) — grouping for the
-- caption editor and (later phases) per-scene cues/overlays. Detection itself runs on the render
-- pipeline (render-pipeline/lib/sceneDetect.js); this column just stores the result.
ALTER TABLE marketing_projects ADD COLUMN scenes_json TEXT;
