// Orchestrates a `spec.mode:'template'` job (Marketing Studio's Video Templates / batch
// generation — see SETUP.md). Each scene (already {{variable}}-resolved by the Worker before
// this ever sees it — see marketingResolveScenes in worker.js) becomes its own short clip, which
// are then concatenated. Much simpler than the caption-clip pipeline: no source video, no
// silence-cut, no cues — just compose text/image scenes back to back.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { downloadToFile } = require('./download');
const { run } = require('./exec');
const { getDurationSec } = require('./probe');
const { uploadOutput } = require('./storage');

function parseResolution(res) {
  const m = /^(\d+)x(\d+)$/.exec(res || '');
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : { w: 1080, h: 1920 };
}

async function renderScene(scene, index, workDir, resolutionW, resolutionH) {
  const duration = Math.max(0.5, Number(scene.duration_sec) || 3);
  const outPath = path.join(workDir, `scene-${index}.mp4`);

  if (scene.type === 'image' && scene.content) {
    const imgPath = path.join(workDir, `scene-${index}-src`);
    await downloadToFile(scene.content, imgPath);
    await run('ffmpeg', [
      '-y', '-loop', '1', '-i', imgPath, '-t', String(duration),
      '-vf', `scale=${resolutionW}:${resolutionH}:force_original_aspect_ratio=increase,crop=${resolutionW}:${resolutionH},fps=30`,
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac',
      '-pix_fmt', 'yuv420p', outPath,
    ]);
  } else {
    // Text scene (or an unrecognized scene type — falls back to a plain title card rather than
    // failing the whole batch over one malformed scene).
    const text = String(scene.content || '').replace(/'/g, "\u2019").replace(/:/g, '\\:');
    await run('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `color=c=${(scene.bg_color || '#111111').replace('#', '0x')}:s=${resolutionW}x${resolutionH}:d=${duration}`,
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest',
      '-vf', `drawtext=text='${text}':fontcolor=${(scene.text_color || '#FFFFFF').replace('#', '0x')}:fontsize=${Math.round(resolutionH * 0.06)}:x=(w-tw)/2:y=(h-th)/2:line_spacing=10`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac',
      '-pix_fmt', 'yuv420p', outPath,
    ]);
  }
  return outPath;
}

async function renderTemplate(job, env) {
  const { spec } = job;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-template-'));
  try {
    const { w: resolutionW, h: resolutionH } = parseResolution(spec.resolution);
    const scenePaths = [];
    for (let i = 0; i < (spec.scenes || []).length; i++) {
      scenePaths.push(await renderScene(spec.scenes[i], i, workDir, resolutionW, resolutionH));
    }
    if (!scenePaths.length) throw new Error('Template has no scenes to render.');

    const concatListPath = path.join(workDir, 'concat.txt');
    fs.writeFileSync(concatListPath, scenePaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

    const concatenatedPath = path.join(workDir, 'concatenated.mp4');
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', concatenatedPath]);

    let finalPath = concatenatedPath;
    if (spec.watermark) {
      finalPath = path.join(workDir, 'output.mp4');
      await run('ffmpeg', [
        '-y', '-i', concatenatedPath,
        '-vf', `drawtext=text='Made with Leadvyne':fontcolor=white@0.75:fontsize=${Math.round(resolutionH * 0.022)}:x=w-tw-24:y=h-th-24:shadowcolor=black@0.6:shadowx=2:shadowy=2`,
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

module.exports = { renderTemplate };
