# Leadvyne Chats v2: design spec

Status: draft for the dev team · Owner: Chats · Date: 10 Oct 2026

Chats v2 rebuilds the inbox (`frontend/chats.html`) around a D1 read model and real-time deltas, so
the list and the open thread load fast, and it adds the agent features from the feature list
(assignment, SLA badges, bot/human status, canned responses, templates, AI assist and so on).

This spec starts from what is in the repo today. Several items on the wish-list already exist in
some form, and the slowest parts of the current page come from its architecture, not its
rendering. Fix the data path first. Every feature after that depends on it.

---

## 1. Where we are today (audit)

### 1.1 How the current page loads

| Step | What happens now | Cost |
|---|---|---|
| List | `fetchLeads()` (`chats.html:169`) asks NocoDB, through the Worker proxy, for up to **200 full lead rows** with every column, **including `ConvHistory`**, the whole JSON transcript of each chat | The payload grows with total chat history (often MBs). NocoDB sits on a separate host, so every request makes an extra network hop |
| List refresh | A 12s poll: deltas on `LastMsgAt`, with a full 200-row reload on every 5th tick (~1 min) | Regular full re-downloads, plus a 12s delay before new messages appear |
| Search | Client-side `JSON.parse` of every lead's `ConvHistory` on each keystroke (`renderContacts`) | The main thread blocks while you type |
| Unread | `localStorage` per browser (`readMap`) | Wrong on a second device, not shared with teammates, and impossible to count on the server |
| Thread | `GET /chat/messages` (`worker.js:1506`): a NocoDB fetch of the lead (ownership check), then `COUNT(*)`, a lazy ConvHistory seed, a **Chatwoot media backfill on every open**, then **all** messages `ORDER BY ts ASC`, unpaged | 2–3 serial upstream calls before the first byte, and a payload that grows with the length of the chat |
| Real-time | `ClientUpdatesHub` (a Durable Object with Hibernation) already exists, and `engineBroadcastUpdate` is called from 8 sites. `chats.html` does not open a socket. It only gets a `postMessage` nudge from the dashboard | The pieces exist but Chats doesn't use them |
| Bundle | One 88KB HTML file with inline CSS/JS. The emoji list, template picker, MP3 encoder hook, lightbox and recorder all ship up front | Fine on its own. It will grow badly as v2 features are added |

### 1.2 Wish-list items that already exist

| Item | State | Where |
|---|---|---|
| All / Unread / Needs you / Mine / Resolved tabs | ✅ exists, counts are computed on the client | `renderFilters` |
| WhatsApp formatting render (`*b*` `_i_` `~s~` ```` ``` ````) | ✅ exists | `fmtText` (`chats.html:223`) |
| `**x**` → `*x*` before sending | ❌ missing | `handleChatSend` sends the text unchanged |
| Date separators | ✅ partial (`.day` / `fmtDay`): no "Yesterday" / "Today" labels | |
| Quote reply + preview bar | ✅ exists (`setReply` / `renderReply`) | |
| Reply hover action | ✅ exists (`.msg-actions`) | |
| Drag & drop, paste images | ✅ exists (`.thread.drop`, `onPaste`) | |
| 24h window bar + template picker with variables | ✅ partial: the bar warns, but free text is not disabled | `updateWindowBar`, `openTemplates` |
| Internal notes with yellow background | ✅ exists (`composeMode='note'`) | No `@mention` yet |
| Voice notes | ✅ records to **MP3** (`toMp3` / lame) | v2 needs OGG/Opus |
| Audio player with speed control | ✅ exists (`cycleSpeed`) | |
| Image lightbox, doc card | ✅ exists | No PDF preview, location card or vCard yet |
| Jump to latest + counter | ✅ exists (`.to-bottom`, `unseen`) | |
| Search in conversation | ✅ dims non-matches | No match highlighting or ↑/↓ arrows |
| Failed-send ⚠️ + retry | ✅ partial (`tick-failed`) | No Meta error reason |
| Pin, Resolve, Take over / hand back | ✅ in the ⋮ menu | Needs to move into the header (P1) |
| "Seen by" presence | ✅ dashboard sends a `viewing` heartbeat through the DO | Chats v2 adds `typing` |
| Labels | ✅ `Tags` on leads (dashboard) | Not shown in Chats |
| Canned responses | ❌ none anywhere | New table |
| Sender attribution | ❌ agent sends are stored as `role:'assistant'`, the same as the bot | Schema change |

**Takeaway:** about a third of the P1/P2 UI already exists. The large missing pieces are the
**data model** (who sent a message, assignment, status, labels and SLA in one fast-to-query place)
and **real-time delivery**.

---

## 2. Performance targets

| Metric (`performance.mark`) | Target, warm (cached) | Target, cold (first visit, 4G) |
|---|---|---|
| `list-visible`: first 20 rows painted | **< 100 ms** (IndexedDB snapshot) | < 700 ms |
| `thread-visible`: last 30 messages painted | **< 50 ms** (memory) | < 350 ms |
| `delta-to-screen`: inbound message → row moves + bubble shows | < 1 s p95 | |
| List API (`/chats/v2/list`) Worker wall time | < 40 ms p95 | |
| Thread API (`/chats/v2/thread`) Worker wall time | < 40 ms p95 | |
| Initial JS + CSS for Chats | < 60 KB gzipped | |

Instrument these targets **before** changing anything. Report them with `navigator.sendBeacon` to a
`/chats/v2/rum` endpoint that writes to Workers Analytics Engine, and log D1 `meta.duration` for
each query. The before/after numbers are what will show v2 is faster.

---

## 3. Architecture

```
 WhatsApp / IG / Chatwoot webhooks ─┐
 Bot engine replies ────────────────┤        ┌──────────────────────────────┐
 Agent actions (/chats/v2/*) ───────┼──────► │ chatWrite() (one choke point)│
                                    │        │  1. INSERT lead_messages     │
                                    │        │  2. UPSERT conversations     │ D1
                                    │        │  3. engineBroadcastUpdate()  │───► ClientUpdatesHub DO
                                    │        └──────────────────────────────┘        │  (hibernating WS)
 NocoDB leads (system of record) ◄──┘  (still dual-written, as today)                 ▼
                                                                         chats.html v2 (1 socket/tab)
```

**Principle:** NocoDB stays the system of record for *leads*. D1 becomes the system of record
for the *inbox*: the conversation list row, the messages, and the inbox state (assignee, status,
labels, priority, snooze, unread). The inbox never reads NocoDB on the hot path.

### 3.1 The single write path

Today, messages reach D1 through `d1InsertLeadMessage` / `d1InsertLeadMessages` from about 20 call
sites (engine reply, inbound WhatsApp, Instagram, support, agent send…). v2 wraps these in one
function:

```js
// worker.js
async function chatWrite(env, ctx, {clientId, leadId, msg, convPatch, event}) {
  // msg:       a lead_messages row (optional)
  // convPatch: fields to change on the conversations row (optional)
  // event:     the delta to broadcast; defaults to one built from msg/convPatch
  // 1) INSERT OR IGNORE the message (the dedup index already exists)
  // 2) UPSERT conversations: last_message_*, unread_count, waiting_since, …
  //    (one env.DB.batch() call, so both writes commit together)
  // 3) ctx.waitUntil(engineBroadcastUpdate(env, clientId, delta))
}
```

Each existing `d1InsertLeadMessage` call becomes `chatWrite`. Every place that changes inbox
state (resolve, assign, label, bot toggle, snooze) also goes through `chatWrite`, with a
`convPatch` and an `event` row. As a result, **activity events, list deltas and badge changes all
come from one code path**, and none of them can be skipped by accident.

---

## 4. Data model (D1)

New migration file: `cloudflare-worker/migrations/0112_chats_v2.sql`.

### 4.1 `conversations`: the denormalised list row

```sql
CREATE TABLE IF NOT EXISTS conversations (
  lead_id              INTEGER PRIMARY KEY,          -- = NocoDB lead Id (1 lead = 1 conversation per channel today)
  client_id            INTEGER NOT NULL,
  channel              TEXT    NOT NULL DEFAULT 'whatsapp',  -- whatsapp | instagram
  name                 TEXT    NOT NULL DEFAULT '',
  phone                TEXT    NOT NULL DEFAULT '',
  avatar_url           TEXT    NOT NULL DEFAULT '',
  status               TEXT    NOT NULL DEFAULT 'open',      -- open | pending | snoozed | resolved
  snoozed_until        TEXT,
  handler              TEXT    NOT NULL DEFAULT 'bot',       -- bot | human
  assignee_email       TEXT    NOT NULL DEFAULT '',          -- '' = unassigned
  team_id              INTEGER,
  priority             INTEGER NOT NULL DEFAULT 0,           -- 0 none,1 low,2 med,3 high,4 urgent
  labels               TEXT    NOT NULL DEFAULT '[]',        -- JSON array of label ids (max ~10)
  pinned               INTEGER NOT NULL DEFAULT 0,
  unread_count         INTEGER NOT NULL DEFAULT 0,
  last_message_id      INTEGER,
  last_message_at      TEXT    NOT NULL,
  last_message_preview TEXT    NOT NULL DEFAULT '',          -- ≤120 chars; '📷 Photo', '🎤 Voice note 0:12'
  last_message_dir     TEXT    NOT NULL DEFAULT 'in',        -- in | out | event
  last_customer_at     TEXT,                                 -- drives 24h window + SLA
  waiting_since        TEXT,                                 -- set on customer msg, cleared on human/bot reply
  first_response_secs  INTEGER,
  lead_stage           TEXT    NOT NULL DEFAULT '',
  source               TEXT    NOT NULL DEFAULT '',          -- ad | organic | broadcast …
  ad_referral          TEXT    NOT NULL DEFAULT '{}',        -- Meta referral payload (ad id, headline, url)
  updated_at           TEXT    NOT NULL
);

-- Every list view is (client, filter) ordered by last_message_at with a cursor.
CREATE INDEX IF NOT EXISTS ix_conv_status   ON conversations(client_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS ix_conv_assignee ON conversations(client_id, assignee_email, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS ix_conv_unread   ON conversations(client_id, last_message_at DESC) WHERE unread_count > 0;
CREATE INDEX IF NOT EXISTS ix_conv_waiting  ON conversations(client_id, waiting_since) WHERE waiting_since IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_conv_snooze   ON conversations(snoozed_until) WHERE status = 'snoozed';
```

*Unread semantics:* this is a **shared team inbox** (Chatwoot-style). `unread_count` counts customer
messages since any agent last opened the chat, and resets to 0 when an agent opens it or marks it
read. "Mark as unread" sets it to `max(1, n)`. This replaces the per-browser `localStorage`
read map. The dashboard's `chatIsUnread` / `updateChatBadge` (`chats.js`) move to the server
count as well.

*Labels as JSON:* filtering by label uses `EXISTS (SELECT 1 FROM json_each(labels) WHERE value IN (…))`.
After the indexed `client_id` range scan this is cheap at our sizes (≤ 10k conversations per client).
If one tenant grows large, move labels to a join table `conversation_labels(lead_id, label_id)`.
Don't start with the join table.

### 4.2 `lead_messages`: additive columns

```sql
ALTER TABLE lead_messages ADD COLUMN sender_type  TEXT NOT NULL DEFAULT '';  -- customer | bot | agent | system
ALTER TABLE lead_messages ADD COLUMN sender_email TEXT NOT NULL DEFAULT '';
ALTER TABLE lead_messages ADD COLUMN sender_name  TEXT NOT NULL DEFAULT '';
ALTER TABLE lead_messages ADD COLUMN kind         TEXT NOT NULL DEFAULT 'text'; -- text|image|audio|video|document|location|contacts|interactive|template|note|event
ALTER TABLE lead_messages ADD COLUMN wa_msg_id    TEXT NOT NULL DEFAULT '';  -- for status receipts, reactions, delete
ALTER TABLE lead_messages ADD COLUMN status       TEXT NOT NULL DEFAULT '';  -- queued|sent|delivered|read|failed
ALTER TABLE lead_messages ADD COLUMN error        TEXT NOT NULL DEFAULT '';  -- Meta error code + human reason
ALTER TABLE lead_messages ADD COLUMN meta         TEXT NOT NULL DEFAULT '{}'; -- template name/vars, interactive payload, reactions, event payload
CREATE INDEX IF NOT EXISTS ix_lm_lead_id ON lead_messages(lead_id, id DESC);   -- before_id cursor
CREATE INDEX IF NOT EXISTS ix_lm_wamid  ON lead_messages(wa_msg_id) WHERE wa_msg_id <> '';
```

- Existing rows have `sender_type=''`. The renderer maps `role:user` → customer and
  `role:assistant` → "Bot / team". Only new rows get exact attribution. Don't backfill by guessing.
- **Activity events** are rows with `kind='event'`, `role='system'` and `meta={"type":"assigned","by":…,"to":…}`.
  They page with the thread for free, and they also make up the audit log ("logs the change").
- **Internal notes** are `kind='note'`. They are never sent to Meta and never counted as unread.

### 4.3 Small reference tables

```sql
CREATE TABLE IF NOT EXISTS chat_labels   (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#8696a0', UNIQUE(client_id, name));
CREATE TABLE IF NOT EXISTS canned_responses (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, shortcut TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(client_id, shortcut));
CREATE TABLE IF NOT EXISTS chat_views    (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, owner_email TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, query TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS contact_notes (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, author_email TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_cn_lead ON contact_notes(lead_id, created_at DESC);
-- per-client settings (SLA thresholds, notification defaults) live in the existing client config row, not a new table.
```

The existing lead `Tags` are seeded into `chat_labels` on the first v2 load for each client. When a
label changes in the inbox, the change is written back to NocoDB `Tags` as well, so the Leads tab
stays consistent.

### 4.4 Backfill

`POST /chats/v2/admin/backfill?client_id=` (internal, idempotent). It pages NocoDB leads with
**only** the list fields (`fields=Id,Name,Phone,Channel,Owner,Handover,ConvResolved,Pinned,Tags,LastMsgAt,LastCustomerMsgAt`,
never `ConvHistory`) and upserts `conversations`. The preview text comes from the newest
`lead_messages` row. If no row exists, the lazy ConvHistory seed runs, as `/chat/messages` does
today. Run the backfill per client behind the v2 flag (§9).

### 4.5 Verify with `EXPLAIN QUERY PLAN`

Each list query must show `SEARCH conversations USING INDEX ix_conv_…` and **no**
`USE TEMP B-TREE FOR ORDER BY`. Add this check as a test in `worker.test.js` against a local D1
(miniflare). A query plan that regresses fails CI.

---

## 5. API (Worker)

All routes call `requireSession`. Authorisation is `conversations.client_id = payload.cid`, so
**there is no NocoDB round-trip for the ownership check**. Staff scoping (`isStaff` /
`staffLocked`) moves to the server: a staff session only ever gets `assignee_email IN (me, '')`
(or `= me` when routing is locked). Today this check runs on the client only.

| Route | Purpose | Notes |
|---|---|---|
| `GET /chats/v2/bootstrap` | agents, teams, labels, canned responses, approved templates, SLA settings, `me`, plus a `version` hash | Cached in `localStorage` keyed by `version`. The client sends `?v=` and gets `304` when nothing changed. Templates are cached in KV for 10 minutes per client |
| `GET /chats/v2/list?view=&channel=&labels=&sort=&cursor=&limit=30` | List rows only (the §4.1 columns, about 300 bytes per row) | Cursor = `base64(last_message_at,lead_id)`, using a `(last_message_at, lead_id) < (?, ?)` keyset. **No `OFFSET`** |
| `GET /chats/v2/counts` | `{all, unread, needs_you, mine, unassigned, pending, snoozed, resolved}` | One `SELECT SUM(CASE …)` over `client_id`. See below |
| `GET /chats/v2/thread?lead_id=&before_id=&limit=30` | Newest 30 messages, newest first. The client reverses them | Returns `{messages, has_more, conversation}`. The Chatwoot media backfill moves to a one-time `ctx.waitUntil`, recorded with a `meta.backfilled` flag, and is **never awaited** on the read path |
| `GET /chats/v2/search?q=` | Name/phone prefix plus message full-text | Uses an FTS5 `lead_messages_fts` (`content`, contentless, keyed on rowid) |
| `POST /chats/v2/act` | `{ids:[…], op, args}`, where `op` ∈ `assign, resolve, reopen, snooze, pending, label_add, label_remove, priority, handler, pin, mark_read, mark_unread, stage` | Bulk-safe: one `DB.batch`, one event row per conversation, one broadcast |
| `POST /chats/v2/send` | Text / media / template / note, with `client_msg_id` (a UUID) for optimistic UI and idempotency | Normalises formatting (§6.3), stamps `sender_*`, and returns `{id, client_msg_id, status}` |
| `POST /chats/v2/rum` | Perf beacons | Writes to Analytics Engine |

**Badge counts:** the request asked for counters updated on every write. Don't do that yet. One
grouped `SUM(CASE…)` over a single client's rows (≤ 10k, covered by `ix_conv_status`) takes about
1–3 ms in D1. Write-side counters add drift bugs on every new code path, and the client already
updates counts from deltas between fetches. Revisit only if `counts` shows > 20 ms p95 in RUM.

**Snooze wake-up:** the existing `*/15` cron runs `UPDATE conversations SET status='open' WHERE status='snoozed' AND snoozed_until<=now`
and broadcasts the change. That means up to 15 minutes of granularity. If "1 hour" needs to be
exact, schedule a DO alarm on `ClientUpdatesHub` instead. It already uses alarms.

### 5.1 Real-time protocol (existing `/engine/live` socket)

Chats v2 opens **one** socket per tab: `wss://…/engine/live?token=…&email=…&name=…`. The Hub
stays the same per-client DO with Hibernation. It already relays `viewing`, and `/broadcast`
already fans out to every socket.

Server → client deltas. Each one carries just enough to patch the in-memory state, so nothing is
refetched:

```jsonc
{"t":"msg",   "lead_id":1, "msg":{…row…}, "conv":{…list-row fields that changed…}}
{"t":"conv",  "lead_id":1, "conv":{"status":"resolved","assignee_email":"…"}}   // from /act
{"t":"status","lead_id":1, "wa_msg_id":"…", "status":"read"}                     // Meta receipts
{"t":"typing","lead_id":1, "who":"customer"|"agent:shafna@…"}
{"t":"viewing","lead_id":1, "email":"…", "name":"…"}                             // exists today
{"t":"cfg",   "version":"…"}                                                      // labels/canned changed → refetch bootstrap
```

Client → server: `viewing` (exists), `typing` (throttled to one every 3 seconds, relayed only and
not stored).

Reconnect with backoff (1s, 2s, 5s, 10s). After a reconnect, call
`list?updated_since=<last delta ts>` to cover the gap. **Remove** the 12s poll and the ↻ refresh
button once socket delivery is confirmed in RUM. Until then, keep a 60s
`updated_since` safety poll.

---

## 6. Frontend

### 6.1 Stack decision: stay vanilla, use ES modules, no build step

The tips in the request assume React + TanStack. **This repo has no bundler.** Every page is a
static HTML file served by nginx, and the dashboard's 1.4MB HTML works the same way. Adding
React + Vite to one page means a new build pipeline, a new deploy path and a new set of
dependencies to keep updated, and most of the speed gain comes from the data path anyway. The
alternatives below give the same behaviour without adding a build:

| Need | Approach |
|---|---|
| Virtual list | Rows are a fixed 76px high, so the list is a spacer div plus about 20 absolutely positioned rows that get recycled. That's about 60 lines of code with no dependency. Rows keep a fixed height, and any wrap is truncated with an ellipsis |
| Query cache (SWR) | `Map` LRU of the last 30 threads in memory, plus an IndexedDB snapshot of the list's first page and the last 10 threads. Render from the cache immediately, then revalidate |
| Code splitting | Split `chats.html` into `chats-v2/core.js` (list, thread, composer) and lazily `import()`ed modules: `emoji.js`, `templates.js`, `lightbox.js`, `recorder.js` (+ the Opus encoder), `sidebar.js`, `ai.js`, `filters-advanced.js`. Native dynamic `import()` needs no bundler |
| Cache-busting | `?v=<git sha>` on module URLs, written by the existing deploy. `sw.js` precaches `core.js` |
| Rendering | Keyed DOM patching per message (`data-id`). Never rebuild `#thread.innerHTML` on a delta, as `drawMessages` does today |

If the team later moves the dashboard to a framework, Chats v2's modules can be wrapped as-is.

### 6.2 Load sequence

```
t=0    HTML (≈8KB) + core.js (≈45KB gz) from cache/CDN; skeleton rows painted
t≈30ms IndexedDB: last list snapshot → render rows  ── mark("list-visible", warm)
       open socket ∥ GET bootstrap?v= (304 usually) ∥ GET list?view=current
t≈300  fresh list merged by lead_id (no flash: patch rows in place)
open   memory hit → draw instantly ── mark("thread-visible", warm); GET thread revalidates
hover  150ms on a row → prefetch thread (max 2 in flight, skip on Save-Data / 2G)
idle   requestIdleCallback → import('emoji.js','templates.js') warm-up
```

### 6.3 Formatting (P1)

One shared function, `toWhatsApp(text)`, lives in the Worker. It is applied in `/chats/v2/send`
**and** on the engine's bot reply path, since LLM output is the main source of `**bold**`:

- `**x**` → `*x*`, `__x__` → `_x_`, `~~x~~` → `~x~`, `# Heading` → `*Heading*`, `[text](url)` → `text: url`, and `- ` bullets → `• `
- Code fences are left untouched.
- Unit-test it in `worker.test.js`, including nested and unbalanced markers.

On the client, `fmtText` already renders `*b* _i_ ~s~ ```m```` ````. v2 adds inline `` `code` ``,
plus linkification of `+91…` phone numbers (`tel:`) and emails (`mailto:`). All of it runs **after**
`esc()`, as it does today.

---

## 7. UI spec by area, with acceptance criteria

Legend: **[E]** exists and gets polished · **[N]** new. Every item lists its acceptance criteria (AC).

### 7.1 Chat list

**Tabs** (P1 adds Unassigned; P2 adds Pending and Snoozed). Order: All · Unread · Needs you · Mine · Unassigned · Pending · Snoozed · Resolved.
- AC: each tab is a server `view`. The count comes from `/counts` and changes with deltas within 1s. A staff member whose routing is locked doesn't see Unassigned.

**Bot / human filter (P1)** [N]: a segmented control `All · 🤖 Bot · 👤 Human` that combines with any tab. Each row shows 🤖 or 👤 next to the time.
- AC: filtering calls `list?handler=`. Toggling a conversation's handler moves the row in or out of the filtered list live.

**Row layout (P1/P2)**, fixed 76px:
```
[avatar ◦ch]  Name                         🤖  12:41
              [Hot][Kerala] +1   ● prio     ⏱ 23m   (2)
              ✓✓ Shafna: Sure, sending the quote…  [SA]
```
- Assignee avatar/initials (P1). Waiting badge `⏱ 23m` (P1): amber at ≥ SLA-warn (default 15 min), red at ≥ SLA-breach (default 60 min), computed on the client from `waiting_since` with a 30s ticker and no refetch. SLA thresholds come from `bootstrap.settings`.
- Up to 2 label chips then `+N`, a priority dot, and a channel badge on the avatar when channel = All (P2).
- Preview text: `typing…` (green italic, from a `typing` delta, expires after 6s) › last message preview. Media shows its kind label (`🎤 Voice note 0:12`, `📷 Photo`, `📄 invoice.pdf`, `📍 Location`). The label is generated **on the server** when the row is written, so it's never blank.
- AC: a list of 2,000 rows scrolls at 60fps on a mid-range Android device, with ≤ 30 row DOM nodes in the document.

**Sort (P2):** newest (default) · oldest · waiting longest (`ix_conv_waiting`) · priority · unread first.
**Label filter (P2):** a multi-select dropdown with OR semantics.
**Advanced filter builder (P3)** and **saved views (P3):** a small JSON query AST `{all:[{f:'label',op:'in',v:[3]},{f:'assignee',op:'eq',v:'shafna@'},{f:'last_message_age',op:'gt',v:7200}]}`, compiled to parameterised SQL on the server from a **whitelist** of fields and operators. Never accept raw SQL. Saved views are stored in `chat_views` and shown under the tabs.

**Bulk actions (P2):** a checkbox appears on avatar hover, and the first tick enters selection mode. "Select all" selects the loaded rows, with an option to "select all N matching" (server-side by view). The action bar offers Assign · Resolve · Label · Mark read · Snooze, all through one `/act` call.
- AC: bulk-resolving 50 chats takes one request, produces one broadcast, and every agent's list updates.

**Row menu (P2):** right-click on desktop or a 500ms long-press on touch: Mark unread · Pin · Assign ▸ · Resolve · Snooze ▸.

### 7.2 Conversation header

```
← [avatar] Name  · +91 98…   [🤖 Bot active ▾]  [👤 Shafna ▾]  [🏷]  [● High ▾]  [⏳ 6h 12m]  [✓ Resolve ▾]  ⋮
```
- **Bot status pill (P1)** [E→header]: one click toggles `handler` through `/act op=handler`, which writes an event row ("Shafna took over from the bot"). The existing `/chat/handover` logic, which flips the NocoDB `Handover` that the engine reads, keeps running. `/act` calls it, so the bot's behaviour is unchanged.
- **Resolve ▾ (P1)**: the main click resolves. The dropdown offers Snooze until… 1 hour · Tomorrow 9am (client TZ) · Next Monday 9am · Custom (datetime picker). A resolved chat shows **Reopen**. A new customer message automatically reopens a resolved or snoozed chat (in `chatWrite`).
- **Assignee ▾ (P1)**: a searchable list with Teams, Agents (online dot from the socket) and Unassign. Assigning sends an `assigned` event and a desktop notification to the new assignee. It also writes `Owner` back to NocoDB, so Lead Routing and the Leads tab stay correct.
- **Labels (P2)** with inline create ("+ Create 'Hot lead'"). **Priority (P2)**.
- **24h timer (P2)**: `Session closes in 6h 12m`, red under 1h, from `last_customer_at`. Hidden for Instagram, whose window rules differ: 7 days with the human-agent tag.
- **Lead stage (P3)**: a chip that reads and writes NocoDB `Status` through the existing industry pipeline config (`dashboard.html:1270`). The chip changes the stage, and the Sales module stays the system of record for stages.
- **⋮ menu additions:** Mark unread (P2), Block contact (P2, Meta block API + `blocked` flag), Export (P2: TXT is a streamed Worker response; PDF uses the self-hosted jsPDF already in `vendor/`), Merge contact (P3), Email transcript (P3).

### 7.3 Message area

- **Sender attribution (P1)** [N]: 11px text above the first bubble of each outgoing group: `🤖 AI Bot` / `Shafna` / `📢 Broadcast` / `⚙️ Automation`. Legacy rows show nothing rather than a guessed sender.
- **Date separators (P1)** [E]: Today / Yesterday / weekday for the last 7 days / `8 Oct 2026`. Sticky while scrolling.
- **Unread divider (P1)** [N]: a "N unread messages" divider goes above the first message newer than the conversation's `last_read_id`, which is captured **before** the open marks it read. On open, the thread scrolls to the divider instead of the bottom.
- **Activity events (P2):** centred grey pill lines.
- **Links, phone numbers and emails (P2).**
- **Media (P2):** thumbnail-first images (`loading="lazy"`, `width`/`height` set so the layout doesn't shift), a lightbox from the lazy `lightbox.js`, the audio player [E], a PDF card with page-1 preview (generated at upload and stored next to the file), a location card (static map image, click → Google Maps), and a vCard card with "Add as lead".
- **Interactive and template messages (P2):** buttons and lists rendered as WhatsApp does. The customer's choice shows as `↩ Selected: "Book a call"`. Templates show a `Template · order_update` badge.
- **Failed send (P2):** `⚠️ Not delivered · Outside 24h window · Retry`. The reason comes from Meta's error code, mapped to plain-language text (131047 → "24-hour window closed, send a template", 131026 → "Number not on WhatsApp", …).
- **Hover actions:** Reply [E] (P1) · Copy (P2) · React (P2, through the WA reactions API by `wa_msg_id`) · Translate (P2, Workers AI or Gemini with a cached result in `meta.tr`, Malayalam/Manglish ↔ English, shown under the bubble and never overwriting the original) · Forward / Delete for everyone (only for messages under 48h old, which is WhatsApp's limit) / Create task (P3; tasks reuse the existing `pm_` tasks module).
- **Navigation:** Jump to latest with a counter [E]. In-chat search (P2) uses `/search?lead_id=`, highlights matches with `<mark>`, steps through them with ↑/↓, and loads older pages until a match is found.
- **Scroll anchoring on prepend:** record `scrollHeight - scrollTop` before inserting older messages and restore it after. Trigger the fetch with an IntersectionObserver sentinel on the 5th-oldest bubble.

### 7.4 Composer

- **Canned responses (P1)** [N]: typing `/` at the start of a word opens a fuzzy popover over `bootstrap.canned`. ↑↓ moves through it, and Enter/Tab inserts. `{{name}} {{phone}} {{agent}} {{business}}` resolve on the client from the conversation and session. An unknown variable stays highlighted and blocks sending until it's filled in. Canned responses are managed in Settings → Canned responses.
- **24h lock (P1)** [E→enforce]: when the window is closed the textarea is **disabled** and replaced by `Session expired. Send a template to restart the conversation [Choose template]`. Notes remain available. The existing template picker fills in the variables, which can come from canned variables.
- **Quote bar (P1)** [E]. **Enter / Shift+Enter, paste, drag-drop (P1)** [E]. Verify that these still work after the refactor, and cover them in `chats-composer.spec.js`.
- **AI ✨ (P2):** Rephrase · Friendlier · Shorter · Fix grammar · To Malayalam. The result replaces the draft, with undo. **Suggested replies (P2):** 1–3 chips, fetched only when an agent opens a chat that is `waiting_since` and handled by a human, and cached per `last_message_id`. **Summarise (P3):** shown automatically on the handover event. The existing voice-summary prompt code (`worker.js:18964`) already builds a transcript from `lead_messages`, so reuse it.
- **Notes (P2):** yellow [E], plus `@mention` autocomplete from `bootstrap.agents`, which sends a WS `mention` delta and a desktop notification.
- **Send ▾ (P2):** Send · Send & resolve · Schedule… (P3).
- **Voice → OGG/Opus (P2):** WhatsApp only accepts `audio/ogg; codecs=opus` as a *voice note*. MP3 arrives as an audio file instead. Chrome/Edge/Firefox `MediaRecorder` record `audio/webm;codecs=opus`, and Firefox records `audio/ogg;codecs=opus` natively. Remux WebM → OGG on the client with a small Opus-in-OGG muxer (no re-encode) in `recorder.js`. Safari records MP4/AAC, so on Safari fall back to the current MP3 path.
- **Signature toggle, payment link (P3).**

### 7.5 Contact sidebar (lazy `sidebar.js`, collapsible, state remembered per agent)

- P1: name, phone and email, editable inline (PATCH NocoDB and update `conversations.name`), plus previous conversations. Today 1 lead = 1 thread, so "previous conversations" means the resolve/reopen cycles taken from the event rows, plus the same phone number on other channels.
- P2: industry-specific custom attributes. Each vertical defines its fields in the client config (`industry` → field schema): Travel (destination, dates, pax, budget), Clinic (doctor, appointment), Ecom (order id, delivery status). The values live in NocoDB lead columns the dashboard already has.
- P2: conversation info: first response time, created date, source, and the **Meta ad referral** (headline, thumbnail, ad id), taken from the `referral` object on the first inbound WA message and stored in `conversations.ad_referral`.
- P2: contact notes (`contact_notes`), separate from conversation notes.
- P3: macros (a saved list of `/act` ops plus an optional template send), and linked orders and bookings.

### 7.6 Collaboration

- Collision (P2): the header shows "Shafna is viewing" (from the `viewing` delta, which exists) and "Shafna is typing…". When another agent is typing, the composer shows a soft warning and still allows sending.
- Customer typing (P2): only possible where the provider emits it. The WA Cloud API does not send customer typing events, so show this for Instagram, and for WA only if Chatwoot relays it. **Don't promise it for WhatsApp.**
- Notifications (P2): the Notification API plus a short sound for new message / assignment / mention. Agents can toggle each one, and the setting is stored per agent. Only fire when `document.hidden`, or when the chat isn't the open one.
- Shortcuts (P3): `J/K`, `R`, `N`, `E`, `A`, `/`, `Ctrl+K`, and `?` for a help sheet. Disabled while typing in an input.
- CSAT on resolve (P3): a per-client toggle that sends an interactive 1–5 button message, with replies stored as event rows.

---

## 8. Delivery plan

### Sprint 1 (2 weeks): fast data path + P1 core

| # | Work | Done when |
|---|---|---|
| 1 | RUM marks + `/chats/v2/rum` + D1 query timing | Baseline numbers for the current page recorded in this doc |
| 2 | Migration `0112_chats_v2.sql` + `chatWrite()` wired into every `d1InsertLeadMessage` site + backfill | Every inbound and outbound message updates `conversations`; the backfill completes for all clients |
| 3 | `/list`, `/counts`, `/thread` (cursor), `/act`, `/bootstrap` | `EXPLAIN` test green; p95 < 40 ms |
| 4 | Socket in Chats + delta handlers; poll reduced to a 60s safety net | A new message appears in < 1s p95 |
| 5 | `core.js` virtual list + cursor paging + IndexedDB snapshot + memory thread cache + skeletons | Warm `list-visible` < 100 ms |
| 6 | `toWhatsApp()` on send + bot path; sender attribution on new rows | Unit tests; no `**` reaches customers |
| 7 | Header: bot pill, Resolve ▾ with snooze, Assignee ▾ + Unassigned tab + avatar + waiting badge | Each action writes an event row and broadcasts |
| 8 | Date separators (Today/Yesterday) + unread divider + scroll-to-divider | |
| 9 | Canned responses (table, settings UI, `/` popover) + enforced 24h lock | |

### Sprint 2: P2 list and thread polish
Labels, priority, sort, snooze/pending tabs, bulk + row menu, media cards, failed-send reasons, events, hover actions, in-chat search, 24h timer, sidebar P2, collision, notifications.

### Sprint 3: AI + P3
✨ rewrite, suggestions, translate, summarise, OGG voice, advanced filters, saved views, macros, shortcuts, CSAT, export, merge.

---

## 9. Rollout and safety

- **Feature flag** `chats_v2` on the client config row. `chats.js` picks `chats.html` or
  `chats-v2/index.html` for the iframe `src`. The v1 page keeps working against its old
  endpoints until every client has been migrated, so dual-writing to `ConvHistory` and
  `lead_messages` continues.
- The engine keeps reading NocoDB `Handover` / `ConvHistory`. v2 changes **how the inbox reads**,
  not how the bot decides. Every engine-facing field written by `/act` must stay in sync, and each
  one needs a test.
- Read **FIXES.md** before touching `handleChatSend`, the handover paths or the engine reply path.
  Several entries cover these paths.
- Tests: extend `frontend/tests/chats-*.spec.js` (Playwright) with a v2 fixture server. Cover the
  list virtualisation, cursor paging, delta merge, 24h lock, canned insert, and the unread divider.
- Pilot on 2 clients for one week while watching RUM, then ramp to everyone.

## 10. Open questions

1. **Assignee identity:** sessions carry only `{cid, exp}` and no agent identity (see the
   `ClientUpdatesHub` comment). Attribution and "Mine" rely on the email the tab reports about
   itself. Is that acceptable, or should v2 add a per-agent claim to the session token first?
   (Recommendation: add the claim in Sprint 1. Assignment and the audit log depend on it.)
2. **Teams:** no team entity exists today. Should teams be created in Chats v2 settings, or derived
   from roles in `team_permissions`?
3. **Instagram 24h rules:** a separate timer (7 days with the human-agent tag) or none at all?
4. **SLA:** one setting per client, or per label/priority as well?

---

## 11. Implementation status (10 Oct 2026)

Built on branch `claude/compassionate-planck-bo9f5m`. Backend: `cloudflare-worker/chats-v2.js`
(+ wiring in `worker.js`), tests in `chats-v2.test.js`. Frontend: `frontend/chats.html`, tests in
`frontend/tests/chats-v2.spec.js`. The page uses `/chats/v2/*` when reachable and otherwise runs
exactly as v1, so a v2 outage can't blank Chats. The D1 schema is created by the Worker on first
use; `migrations/0112_chats_v2.sql` mirrors the tables but leaves the `lead_messages` columns to
the Worker.

Changes from the plan above:
- Agent identity: sessions already carry a signed email (`signSession`), so open question 1 is
  resolved — attribution, "Mine" and assignment use it.
- Labels are stored as names (the lead's existing `Tags`), not ids.
- Live deltas carry chat ids only (`{type:'conv', lead_ids}`), never names or text; the page
  fetches changed rows through the access-checked list API. Staff can't read others' chats off
  the shared socket.
- Contact notes reuse the lead's `NotesList` (1 lead = 1 conversation today).
- Scheduled messages go out on the existing `*/15` cron (up to 15 minutes late).
- Bot replies get Markdown → WhatsApp conversion for every client (`toWhatsApp`).

Built: everything in P1; in P2/P3 — Unassigned/Pending/Snoozed tabs, bot/human filter, sort,
label filter, advanced filter + saved views, row badges (assignee, SLA wait, labels, priority,
channel), bulk actions, row menu, header pill/assign/resolve+snooze/labels/priority/24h timer/
stage chip, mark unread, block, export TXT/PDF, email transcript, sender attribution, date
separators, unread divider, activity events, links/phones/emails, location and contact cards, bot
quick-reply buttons, failed-send reasons, translate, forward, create task, in-chat search with
▲/▼, canned responses, 24h lock, send & resolve, schedule, signature, ✨ rewrite, suggested
replies, summarise, @mentions, contact sidebar with vertical fields, macros, collision
(viewing/typing), notifications, keyboard shortcuts, RUM marks.

Not built, and why:
- Customer "typing…" on WhatsApp: the Cloud API doesn't send it.
- Write-time badge counters: one indexed count query is cheaper and can't drift.
- React/TanStack rewrite: no build pipeline in this repo; the gains came from the data path.
- Voice notes as OGG/Opus: still MP3 in Chrome (needs a WebM→Ogg remuxer; next).
- Emoji reactions and delete-for-everyone: need the WhatsApp message id (wamid), which this app
  doesn't store, and Chatwoot doesn't relay either action.
- Merge contact, CSAT on resolve, payment-link button: need product decisions (data model for
  merged leads; how CSAT replies avoid triggering the bot; which payment provider/keys).
