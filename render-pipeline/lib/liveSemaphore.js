// Small non-blocking semaphore for latency-sensitive live work. Unlike the render queue, callers
// never wait here: when both AI4Bharat slots are occupied the API returns 429 immediately, letting
// the Cloudflare Worker use Sarvam instead of building an unbounded CPU/RAM-heavy backlog.
function createLiveSemaphore(maxConcurrent = 2) {
  let active = 0;
  return {
    tryAcquire() {
      if (active >= maxConcurrent) return false;
      active += 1;
      return true;
    },
    release() {
      if (active > 0) active -= 1;
    },
    get active() { return active; },
    get limit() { return maxConcurrent; },
  };
}

module.exports = { createLiveSemaphore };
