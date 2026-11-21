# Follow-up V3 reliability upgrade

Enabled no longer means healthy. Follow-ups shows the last attempted and successful runs, checked
lead count, due count, errors, and API acceptance / delivery / read totals separately.

## Deployment

1. Deploy `cloudflare-worker/wrangler.toml` with its new `FollowupV3Scheduler` SQLite Durable Object
   migration, and deploy the updated `frontend/broadcast.html` and `frontend/followup-status.js`.
   `worker-entry.js` already re-exports all Worker classes, including the new class. The existing
   production Worker action deploys the checked-in config on merge to main.
2. D1's V3 initialization adds missing health and delivery columns automatically. It ignores only
   duplicate-column errors; storage failures block execution. Migration 0121 creates the job ledger
   for installations using explicit D1 migrations too. No NocoDB schema setup is required for the
   new features.
3. Keep the `*/15 * * * *` trigger: it now repairs tenant alarm scheduling. Each tenant's durable
   alarm evaluates its leads, sleeps until the next scheduled action (at most 15 minutes), and
   persists a recovery alarm before network work. Without the new binding, the cron remains a
   functional fallback. The 10-minute database lock still excludes overlapping cron/manual runs.
4. Chatwoot session-send receipts use `message_updated` on the existing secret-protected engine
   hook, scoped to its authenticated client. Saving/synchronizing the channel updates that hook's
   subscriptions. It handles delivery events before message dedup, and does not run the reply bot.
5. Direct Meta template-send receipts need signed `messages` status events routed to
   `https://<worker>/followups/meta-status`. Set `META_APP_SECRET` and a new
   `META_FOLLOWUP_VERIFY_TOKEN` secret for challenge verification. Preserve any existing inbound
   message callback; arrange status routing in the existing integration rather than replacing it.
   The endpoint rejects missing/invalid signatures and returns an error if persistence fails.
   Until receipt routing is configured, the dashboard correctly shows only API acceptance.
6. Open Follow-ups and use **Check now — no messages sent**. This reads live leads and shows
   eligibility, blockers, and up to 100 sample leads without template submission, AI generation,
   sequence writes, conversion attribution, or sends. It only records the check timestamp.
   **Send due follow-ups** is a separate action and respects caps and stop rules.

## Behavior

- `staff_reply_hours` defaults to 24: after a team reply, wait that long before the next eligible
  follow-up. Set 0 to keep the previous wait-for-customer behavior. This does not reopen the
  WhatsApp session window. Explicit handover and booked-meeting holds remain in force until
  resolved; orders, opt-outs, won, booked, closed and configured exit stages still stop sends.
- Optional stage sequences customize session wording/timing and template names/languages for
  new enquiries, demo pending/completed, quotation sent and payment pending. Match the actual CRM
  stage keys. Enabling a stage does not restart a completed cycle or automatically send a second
  set of steps. Unset stage steps inherit the shared ladder; no stage is enabled automatically.
- Before each message, re-read lead ownership, replies, opt-out, handover and stage, account pause
  and enable settings, meetings and orders. The order check bypasses its 30-minute cache. Failure
  to verify a live lead/order/meeting aborts the batch rather than treating the check as clear.
- Verify the exact selected A/B template name and language against that lead's WABA before send,
  including templates previously marked approved. Saved names alone are not reported approved.
- An atomic `(client, lead, cycle, step)` claim precedes the provider call. Re-engagement uses its
  scheduled occurrence as the claim cycle, allowing the configured multiple spaced re-engagements.
  Known rejections follow bounded retries/backoff; ambiguous acceptance (timeouts, lost send
  persistence) holds the lead. Review held attempts against the actual provider conversation.
  After ten minutes, **Verified sent** recovers a missing send record; **Verified not sent** permits
  the normal retry path. Verification never bypasses current eligibility or sends immediately.
- Each execution sends at most 50 due messages and respects rolling account/lead caps and warmup.
  Tenant scans remain bounded to 6,000 leads; an oversized scan explicitly fails before sending.
  This version uses a per-tenant durable alarm and the D1 per-lead schedule, rather than spawning
  one Durable Object for every lead. Larger accounts need incremental scan pagination next.

## Validation

Run `node --test followup-v3.test.js followup-scheduler.test.js` from `cloudflare-worker`.
The tests use SQLite-backed D1 and mocked providers. They cover preview isolation, fresh replies
and opt-outs, duplicate claims, uncertain sends, visible read/write failures, stage overrides,
receipt ordering, durable alarm persistence/tenant isolation, and webhook authentication.

The broad Worker suite has an existing `flight details card` expectation mismatch (19:00 actual
versus 20:00 expected), reproduced on unchanged main commit `44f606f`. Production cron delivery,
D1 permissions and real provider delivery still require post-deployment verification.
