// Same HMAC-SHA256-base64-over-raw-body scheme as worker.js's hmacSha256Base64/
// verifyHmacSignature (see cloudflare-worker/worker.js) — this service and the Worker must agree
// bit-for-bit, so this mirrors that implementation rather than doing anything Node-idiomatic-but-
// different (e.g. base64url).
const crypto = require('crypto');

function sign(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

function verify(secret, rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = sign(secret, rawBody);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signatureHeader), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { sign, verify };
