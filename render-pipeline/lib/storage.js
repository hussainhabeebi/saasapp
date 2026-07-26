// Uploads a rendered file back into the SAME R2 bucket the Worker already serves from
// (MARKETING_MEDIA / leadvyne-marketing-media) via R2's S3-compatible API, so the callback to
// the Worker can hand back an `output_key` and let the existing, already-built
// GET /marketing/media/:key route (range-request support included) serve it — no second CDN/
// hosting story needed. Falls back to serving the file from this same process (LOCAL_PUBLIC_BASE_URL)
// if R2 credentials aren't set, so the pipeline is runnable/testable without a Cloudflare account.
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

function r2Configured(env) {
  return !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET_NAME);
}

function makeR2Client(env) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
}

// Returns {output_key} (R2-backed) or {output_url} (local fallback) — the two shapes
// handleMarketingRenderWebhook already accepts, see worker.js.
async function uploadOutput(env, localFilePath, key) {
  if (r2Configured(env)) {
    const client = makeR2Client(env);
    const body = fs.createReadStream(localFilePath);
    await client.send(new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: 'video/mp4',
    }));
    return { output_key: key };
  }

  if (!env.LOCAL_PUBLIC_BASE_URL) {
    throw new Error('Neither R2 credentials nor LOCAL_PUBLIC_BASE_URL are configured — see .env.example.');
  }
  const publicDir = env.LOCAL_PUBLIC_DIR || path.join(__dirname, '..', 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  const destPath = path.join(publicDir, path.basename(key));
  fs.copyFileSync(localFilePath, destPath);
  return { output_url: `${env.LOCAL_PUBLIC_BASE_URL.replace(/\/$/, '')}/${path.basename(key)}` };
}

module.exports = { uploadOutput, r2Configured };
