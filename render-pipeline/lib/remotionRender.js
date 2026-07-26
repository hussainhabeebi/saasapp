// Orchestrates a `spec.mode:'template', spec.engine:'remotion'` job — real animated video
// compositions (spring/interpolate-driven motion), as opposed to the static text/image "scenes"
// the default ffmpeg engine (lib/templateRender.js) composites. Verified end-to-end in dev: a
// minimal composition bundled, selected, and rendered to a real playable MP4 with visible
// animation (scale+fade) using the system's headless Chromium — see README.md's dev notes.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { bundle } = require('@remotion/bundler');
const { renderMedia, selectComposition } = require('@remotion/renderer');
const { run } = require('./exec');
const { getDurationSec } = require('./probe');
const { uploadOutput } = require('./storage');

const ENTRY_POINT = path.join(__dirname, '..', 'remotion', 'index.jsx');
// Unset lets @remotion/renderer use whichever Chrome Headless Shell it finds/downloaded itself
// (see Dockerfile's `npx remotion browser ensure` build step) — only set this to point at a
// specific binary (e.g. for local dev outside Docker).
const BROWSER_EXECUTABLE = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;

// Bundling (webpack) takes several seconds and produces the same output every time for a given
// checkout — done once per process instead of once per render.
let bundlePromise = null;
function getBundleLocation() {
  if (!bundlePromise) bundlePromise = bundle({ entryPoint: ENTRY_POINT });
  return bundlePromise;
}

function parseResolution(res) {
  const m = /^(\d+)x(\d+)$/.exec(res || '');
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : { w: 1080, h: 1920 };
}

async function renderRemotionTemplate(job, env) {
  const { spec } = job;
  if (!spec.remotion_composition_id) throw new Error('spec.remotion_composition_id is required for the remotion engine.');
  const { w, h } = parseResolution(spec.resolution);
  const inputProps = spec.props || {};

  const serveUrl = await getBundleLocation();
  const composition = await selectComposition({
    serveUrl, id: spec.remotion_composition_id, inputProps, browserExecutable: BROWSER_EXECUTABLE,
  });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-remotion-'));
  try {
    const rawOutputPath = path.join(workDir, 'raw.mp4');
    await renderMedia({
      composition: { ...composition, width: w, height: h },
      serveUrl, codec: 'h264', outputLocation: rawOutputPath, inputProps, browserExecutable: BROWSER_EXECUTABLE,
    });

    let finalPath = rawOutputPath;
    if (spec.watermark) {
      // "Made with Leadvyne" is always plain Latin text — plain drawtext is fine, same as the
      // ffmpeg-engine templates' watermark pass.
      finalPath = path.join(workDir, 'output.mp4');
      await run('ffmpeg', [
        '-y', '-i', rawOutputPath,
        '-vf', `drawtext=text='Made with Leadvyne':fontcolor=white@0.75:fontsize=${Math.round(h * 0.022)}:x=w-tw-24:y=h-th-24:shadowcolor=black@0.6:shadowx=2:shadowy=2`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac',
        finalPath,
      ]);
    }

    const durationSec = await getDurationSec(finalPath);
    const key = `marketing/${job.client_id}/${job.project_id}/render-${crypto.randomBytes(6).toString('hex')}.mp4`;
    const result = await uploadOutput(env, finalPath, key);
    return { ...result, duration_sec: durationSec };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { renderRemotionTemplate };
