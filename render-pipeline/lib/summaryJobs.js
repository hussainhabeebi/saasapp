// End-of-session voice summary jobs. The Worker posts a job and gets 202 immediately; this queue
// runs jobs strictly one at a time (Parler-TTS is heavy) and posts the finished Ogg/Opus back to
// the job's signed callback URL. Primary is Indic Parler-TTS with no time limit; if it fails or is
// unavailable, Piper is the backup. If both fail, the callback reports ok:false and the Worker
// sends nothing (the customer already has every reply as text).
//
// Dependencies are injected so ordering, fallback and callback retries are testable without
// Python, Piper or a network.
function createSummaryJobQueue({ primary, backup, postCallback, callbackRetryDelaysMs = [2000, 8000, 30000], log = console }) {
  const queue = [];
  const seen = new Set();
  let running = false;

  async function synthesize(job) {
    const errors = [];
    for (const provider of [primary, backup]) {
      if (!provider || !provider.supportsLanguage(job.language)) continue;
      try {
        const audio = await provider.synthesize(job.text, job.language);
        if (audio && audio.length >= 200) return { ok: true, provider: provider.name, audio };
        errors.push(`${provider.name}: audio too small`);
      } catch (err) {
        errors.push(`${provider.name}: ${String(err && err.message || err).slice(0, 300)}`);
      }
    }
    return { ok: false, error: errors.join(' | ') || `No provider for language ${job.language}` };
  }

  async function deliver(job, result) {
    const payload = {
      job_id: job.jobId,
      ok: result.ok,
      provider: result.provider || null,
      audio_base64: result.ok ? result.audio.toString('base64') : null,
      error: result.ok ? null : result.error,
    };
    for (let attempt = 0; attempt <= callbackRetryDelaysMs.length; attempt++) {
      try {
        await postCallback(job.callbackUrl, payload);
        return true;
      } catch (err) {
        log.error(`[summary-job] callback failed job=${job.jobId} attempt=${attempt + 1}:`, err.message || err);
        if (attempt < callbackRetryDelaysMs.length) await new Promise(r => setTimeout(r, callbackRetryDelaysMs[attempt]));
      }
    }
    return false;
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        const started = Date.now();
        const result = await synthesize(job);
        log.log(`[summary-job] job=${job.jobId} lang=${job.language} ok=${result.ok} provider=${result.provider || 'none'} ms=${Date.now() - started}`);
        await deliver(job, result);
        seen.delete(job.jobId);
      }
    } finally {
      running = false;
    }
  }

  function enqueue(job) {
    if (seen.has(job.jobId)) return false;
    seen.add(job.jobId);
    queue.push(job);
    drain().catch(err => log.error('[summary-job] queue crashed:', err));
    return true;
  }

  return {
    enqueue,
    get pending() { return queue.length + (running ? 1 : 0); },
    idle: async () => { while (running || queue.length) await new Promise(r => setTimeout(r, 5)); },
  };
}

module.exports = { createSummaryJobQueue };
