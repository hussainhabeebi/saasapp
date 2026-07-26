// Person segmentation for the "text behind subject" caption style — runs RobustVideoMatting
// (https://github.com/PeterL1n/RobustVideoMatting, MIT-licensed model) locally via onnxruntime-node,
// entirely offline, no per-video API cost. This is the "free, local, approximate" option
// (as opposed to a paid video-matting API) — RVM is a real, purpose-built human video matting
// model (not a generic heuristic), but running at a reduced processing resolution/frame-rate for
// speed on CPU means edges are softer than a paid cloud service would give you, especially on
// fast motion or messy backgrounds. See README.md's dev notes for exactly what was and wasn't
// verified — no real human test footage was available in the dev sandbox this was built in.
const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');
const { spawn } = require('child_process');

const MODEL_PATH = process.env.RVM_MODEL_PATH || path.join(__dirname, '..', 'models', 'rvm_mobilenetv3_fp32.onnx');

// Processed at a reduced size for CPU speed/memory — RVM's own recommendation for real-time use
// is to keep the model's internal working resolution modest; the resulting matte is upscaled
// back to the render's target resolution afterwards (softening edges slightly, an accepted
// tradeoff for the free/local tier — see module comment above).
const PROC_WIDTH = 384;
const PROC_FPS = 15;

let sessionPromise = null;
function getSession() {
  if (!sessionPromise) {
    if (!fs.existsSync(MODEL_PATH)) {
      throw new Error(`RVM model not found at ${MODEL_PATH} — see render-pipeline/README.md "Text-behind-subject setup".`);
    }
    sessionPromise = ort.InferenceSession.create(MODEL_PATH);
  }
  return sessionPromise;
}

function zeroState(dims) {
  return new ort.Tensor('float32', new Float32Array(dims.reduce((a, b) => a * b, 1)), dims);
}

// Decodes a video to raw RGB24 frames at the reduced processing resolution/frame-rate via an
// ffmpeg pipe (no temp image files — one process, one stdout stream of fixed-size frame chunks).
function decodeRawFrames(videoPath, procWidth, procHeight, fps) {
  return new Promise((resolve, reject) => {
    const frameBytes = procWidth * procHeight * 3;
    const chunks = [];
    let buffered = Buffer.alloc(0);
    const frames = [];
    const proc = spawn('ffmpeg', [
      '-i', videoPath,
      '-vf', `fps=${fps},scale=${procWidth}:${procHeight}`,
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
    ]);
    proc.stdout.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= frameBytes) {
        frames.push(buffered.subarray(0, frameBytes));
        buffered = buffered.subarray(frameBytes);
      }
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 && !frames.length) return reject(new Error('ffmpeg frame decode failed: ' + stderr.slice(-500)));
      resolve(frames);
    });
  });
}

function rgbBufferToTensor(buf, width, height) {
  const chw = new Float32Array(3 * width * height);
  const plane = width * height;
  for (let i = 0; i < plane; i++) {
    chw[i] = buf[i * 3] / 255;                  // R plane
    chw[plane + i] = buf[i * 3 + 1] / 255;       // G plane
    chw[2 * plane + i] = buf[i * 3 + 2] / 255;   // B plane
  }
  return new ort.Tensor('float32', chw, [1, 3, height, width]);
}

// Runs RVM frame-by-frame, carrying its recurrent hidden state (r1..r4) forward between frames —
// this temporal memory is what RVM uses to stay flicker-free across a video instead of segmenting
// each frame in isolation (a plain frame-by-frame model like most single-image matting networks
// would flicker noticeably here).
async function runMatting(rawFrames, width, height) {
  const session = await getSession();
  let r1 = zeroState([1, 16, height / 2, width / 2]);
  let r2 = zeroState([1, 20, height / 4, width / 4]);
  let r3 = zeroState([1, 40, height / 8, width / 8]);
  let r4 = zeroState([1, 64, height / 16, width / 16]);
  const downsampleRatio = new ort.Tensor('float32', new Float32Array([1.0]), [1]);

  const alphaFrames = [];
  for (const frameBuf of rawFrames) {
    const src = rgbBufferToTensor(frameBuf, width, height);
    const out = await session.run({ src, r1i: r1, r2i: r2, r3i: r3, r4i: r4, downsample_ratio: downsampleRatio });
    r1 = out.r1o; r2 = out.r2o; r3 = out.r3o; r4 = out.r4o;
    const pha = out.pha.data; // Float32Array, values 0..1, length width*height
    const gray = Buffer.alloc(width * height);
    for (let i = 0; i < gray.length; i++) gray[i] = Math.max(0, Math.min(255, Math.round(pha[i] * 255)));
    alphaFrames.push(gray);
  }
  return alphaFrames;
}

function encodeGrayFramesToVideo(alphaFrames, width, height, fps, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${width}x${height}`, '-r', String(fps), '-i', '-',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', outputPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve(outputPath) : reject(new Error('ffmpeg matte encode failed: ' + stderr.slice(-500))));
    for (const frame of alphaFrames) proc.stdin.write(frame);
    proc.stdin.end();
  });
}

// Produces a low-res, low-frame-rate grayscale matte video (white = person, black = background)
// for the given source video. Caller (lib/textBehindSubject.js) upscales it to the render's
// target resolution/frame-rate via ffmpeg when compositing.
async function generateMatte(sourceVideoPath, outputMattePath, aspectRatio) {
  // Must be divisible by 16 — the recurrent state tensors (r1..r4) are built at height/2,
  // /4, /8 and /16, and onnxruntime requires integer tensor dimensions.
  const rawHeight = PROC_WIDTH * (aspectRatio ? 1 / aspectRatio : 16 / 9);
  const procHeight = Math.max(16, Math.round(rawHeight / 16) * 16);
  const rawFrames = await decodeRawFrames(sourceVideoPath, PROC_WIDTH, procHeight, PROC_FPS);
  if (!rawFrames.length) throw new Error('No frames decoded from source video for matting.');
  const alphaFrames = await runMatting(rawFrames, PROC_WIDTH, procHeight);
  await encodeGrayFramesToVideo(alphaFrames, PROC_WIDTH, procHeight, PROC_FPS, outputMattePath);
  return { path: outputMattePath, width: PROC_WIDTH, height: procHeight, fps: PROC_FPS };
}

// decodeRawFrames/runMatting also exported for lib/autoReframe.js — it needs the raw per-frame
// alpha data itself (to compute a subject centroid), not the encoded matte video generateMatte
// produces, so it reuses these two steps directly instead of decoding+matting the source twice.
module.exports = { generateMatte, decodeRawFrames, runMatting, MODEL_PATH, PROC_WIDTH, PROC_FPS };
