// Field Service module — standalone Cloudflare Worker API.
//
// Deliberately separate from cloudflare-worker/worker.js: own D1 database (see wrangler.toml),
// own auth (JWT + PBKDF2, no Authentik/NocoDB dependency), own route surface under /api/*.
// Serves three frontends (../frontend/owner.html, staff.html, customer.html) that talk to this
// Worker only — nothing here is imported by, or imports from, the existing platform.
//
// Multi-tenancy: every table carries tenant_id. A JWT issued at login/signup carries
// {sub:userId, tid:tenantId, role, email}; every authenticated route scopes its queries by the
// tenant_id in that token, never a client-supplied one. Roles: owner > manager > staff.

// ─────────────────────────────── generic helpers ───────────────────────────────

function id() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || '*');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Vary': 'Origin',
  };
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
  });
}

function csv(rows, headers, filename) {
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => esc(row[h])).join(','));
  return new Response(lines.join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ─────────────────────────────── crypto: passwords ───────────────────────────────

const PBKDF2_ITERATIONS = 100000;

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBuf(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr.buffer;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, keyMaterial, 256);
  return { hash: bufToHex(bits), salt: bufToHex(salt.buffer) };
}

async function verifyPassword(password, saltHex, hashHex) {
  const salt = hexToBuf(saltHex);
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, keyMaterial, 256);
  return timingSafeEqual(bufToHex(bits), hashHex);
}

// ─────────────────────────────── crypto: JWT (HS256) ───────────────────────────────

function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeToBuf(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function b64urlDecodeStr(str) {
  return new TextDecoder().decode(b64urlDecodeToBuf(str));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signJwt(payload, secret, expSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + (expSeconds || 60 * 60 * 12) };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

async function verifyJwt(token, secret) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  const [encHeader, encBody, encSig] = parts;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, b64urlDecodeToBuf(encSig), new TextEncoder().encode(`${encHeader}.${encBody}`));
  if (!valid) return null;
  const payload = JSON.parse(b64urlDecodeStr(encBody));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

// ─────────────────────────────── D1 helpers ───────────────────────────────

async function dbAll(env, sql, ...binds) {
  const r = await env.DB.prepare(sql).bind(...binds).all();
  return r.results || [];
}
async function dbGet(env, sql, ...binds) {
  return env.DB.prepare(sql).bind(...binds).first();
}
async function dbRun(env, sql, ...binds) {
  return env.DB.prepare(sql).bind(...binds).run();
}

// ─────────────────────────────── auth middleware ───────────────────────────────

const ROLE_RANK = { staff: 1, manager: 2, owner: 3 };

async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) throw new HttpError(401, 'Missing bearer token');
  const payload = await verifyJwt(m[1], env.SESSION_SIGNING_KEY);
  if (!payload) throw new HttpError(401, 'Invalid or expired token');
  const user = await dbGet(env, 'SELECT * FROM users WHERE id = ? AND tenant_id = ?', payload.sub, payload.tid);
  if (!user || !user.active) throw new HttpError(401, 'Account not found or deactivated');
  return { user, tenantId: payload.tid, role: user.role };
}

function requireRole(auth, minRole) {
  if (ROLE_RANK[auth.role] < ROLE_RANK[minRole]) {
    throw new HttpError(403, `Requires ${minRole} role or higher`);
  }
}

async function requireTenant(env, tenantId) {
  const tenant = await dbGet(env, 'SELECT * FROM tenants WHERE id = ?', tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');
  return tenant;
}

// ─────────────────────────────── body parsing ───────────────────────────────

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(',').map(c => c.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

// ─────────────────────────────── money / tax helpers ───────────────────────────────

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function computeTotals(items, taxRate) {
  const subtotal = round2(items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0));
  const taxAmount = round2(subtotal * (Number(taxRate) || 0) / 100);
  return { subtotal, taxAmount, total: round2(subtotal + taxAmount) };
}

// ═══════════════════════════════ AUTH ROUTES ═══════════════════════════════

async function handleSignup(request, env) {
  const body = await readJson(request);
  const { business_name, owner_name, email, password, currency, tax_mode } = body;
  if (!business_name || !owner_name || !email || !password) throw new HttpError(400, 'business_name, owner_name, email, password are required');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');

  const existing = await dbGet(env, 'SELECT id FROM users WHERE email = ?', email.toLowerCase());
  if (existing) throw new HttpError(409, 'An account with this email already exists');

  const tenantId = id();
  const trialEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const defaultTax = tax_mode === 'gst' ? { mode: 'gst', rate: 18, label: 'GST' } : { mode: 'vat', rate: 5, label: 'VAT' };
  await dbRun(env,
    `INSERT INTO tenants (id, name, currency, tax_mode, tax_rate, tax_label, plan, trial_ends_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'trial', ?, ?)`,
    tenantId, business_name, currency || (tax_mode === 'gst' ? 'INR' : 'AED'), defaultTax.mode, defaultTax.rate, defaultTax.label, trialEnds, nowIso());

  const { hash, salt } = await hashPassword(password);
  const userId = id();
  await dbRun(env,
    `INSERT INTO users (id, tenant_id, email, password_hash, password_salt, role, name, created_at)
     VALUES (?, ?, ?, ?, ?, 'owner', ?, ?)`,
    userId, tenantId, email.toLowerCase(), hash, salt, owner_name, nowIso());

  const token = await signJwt({ sub: userId, tid: tenantId, role: 'owner', email: email.toLowerCase() }, env.SESSION_SIGNING_KEY);
  return json({ token, user: { id: userId, name: owner_name, email: email.toLowerCase(), role: 'owner' }, tenant_id: tenantId }, 201);
}

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

async function handleLogin(request, env) {
  const { email, password } = await readJson(request);
  if (!email || !password) throw new HttpError(400, 'email and password are required');

  const user = await dbGet(env, 'SELECT * FROM users WHERE email = ?', email.toLowerCase());
  if (!user) throw new HttpError(401, 'Invalid email or password');

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new HttpError(423, `Account locked. Try again after ${user.locked_until}`);
  }
  if (!user.active) throw new HttpError(403, 'Account deactivated — contact your business owner');

  const ok = await verifyPassword(password, user.password_salt, user.password_hash);
  if (!ok) {
    const attempts = (user.failed_attempts || 0) + 1;
    const lockedUntil = attempts >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString() : null;
    await dbRun(env, 'UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', attempts, lockedUntil, user.id);
    if (lockedUntil) throw new HttpError(423, `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`);
    throw new HttpError(401, 'Invalid email or password');
  }

  await dbRun(env, 'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', user.id);
  const token = await signJwt({ sub: user.id, tid: user.tenant_id, role: user.role, email: user.email }, env.SESSION_SIGNING_KEY);
  return json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant_id: user.tenant_id });
}

async function handleMe(request, env, auth) {
  const tenant = await requireTenant(env, auth.tenantId);
  return json({
    user: { id: auth.user.id, name: auth.user.name, email: auth.user.email, role: auth.user.role, phone: auth.user.phone },
    tenant: { id: tenant.id, name: tenant.name, currency: tenant.currency, tax_mode: tenant.tax_mode, tax_rate: tenant.tax_rate, tax_label: tenant.tax_label, plan: tenant.plan, trial_ends_at: tenant.trial_ends_at },
  });
}

async function handleGetTenant(request, env, auth) {
  const tenant = await requireTenant(env, auth.tenantId);
  return json(tenant);
}

async function handlePatchTenant(request, env, auth) {
  requireRole(auth, 'owner');
  const body = await readJson(request);
  const fields = ['name', 'currency', 'tax_mode', 'tax_rate', 'tax_label', 'cancellation_fee_type', 'cancellation_fee_value', 'cancellation_window_hours', 'subdomain', 'custom_domain'];
  const sets = [], binds = [];
  for (const f of fields) if (body[f] !== undefined) { sets.push(`${f} = ?`); binds.push(body[f]); }
  if (!sets.length) return json(await requireTenant(env, auth.tenantId));
  binds.push(auth.tenantId);
  await dbRun(env, `UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, ...binds);
  return json(await requireTenant(env, auth.tenantId));
}

// ═══════════════════════════════ STAFF ═══════════════════════════════

async function handleListStaff(request, env, auth) {
  requireRole(auth, 'manager');
  const rows = await dbAll(env, 'SELECT id, email, role, name, phone, active, created_at FROM users WHERE tenant_id = ? ORDER BY created_at', auth.tenantId);
  return json(rows);
}

async function handleCreateStaff(request, env, auth) {
  requireRole(auth, 'manager');
  const body = await readJson(request);
  const { email, password, name, phone, role } = body;
  if (!email || !password || !name) throw new HttpError(400, 'email, password, name are required');
  const wantedRole = role === 'manager' || role === 'owner' ? role : 'staff';
  if (wantedRole !== 'staff') requireRole(auth, 'owner'); // only owner can create managers/owners
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');

  const existing = await dbGet(env, 'SELECT id FROM users WHERE email = ?', email.toLowerCase());
  if (existing) throw new HttpError(409, 'A user with this email already exists');

  const { hash, salt } = await hashPassword(password);
  const userId = id();
  await dbRun(env,
    `INSERT INTO users (id, tenant_id, email, password_hash, password_salt, role, name, phone, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId, auth.tenantId, email.toLowerCase(), hash, salt, wantedRole, name, phone || null, nowIso());
  return json({ id: userId, email: email.toLowerCase(), role: wantedRole, name, phone: phone || null }, 201);
}

async function handlePatchStaff(request, env, auth, params) {
  requireRole(auth, 'manager');
  const target = await dbGet(env, 'SELECT * FROM users WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!target) throw new HttpError(404, 'Staff member not found');
  const body = await readJson(request);
  const sets = [], binds = [];
  if (body.name !== undefined) { sets.push('name = ?'); binds.push(body.name); }
  if (body.phone !== undefined) { sets.push('phone = ?'); binds.push(body.phone); }
  if (body.active !== undefined) { sets.push('active = ?'); binds.push(body.active ? 1 : 0); }
  if (body.role !== undefined && body.role !== target.role) {
    requireRole(auth, 'owner'); // only owner changes roles
    sets.push('role = ?'); binds.push(body.role);
  }
  if (body.password) {
    if (body.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    const { hash, salt } = await hashPassword(body.password);
    sets.push('password_hash = ?', 'password_salt = ?'); binds.push(hash, salt);
  }
  if (!sets.length) return json(target);
  binds.push(params.id, auth.tenantId);
  await dbRun(env, `UPDATE users SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, ...binds);
  return json(await dbGet(env, 'SELECT id, email, role, name, phone, active FROM users WHERE id = ?', params.id));
}

async function handleDeactivateStaff(request, env, auth, params) {
  requireRole(auth, 'owner');
  await dbRun(env, 'UPDATE users SET active = 0 WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  return json({ ok: true });
}

// ═══════════════════════════════ CUSTOMERS ═══════════════════════════════

async function handleListCustomers(request, env, auth) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q');
  const rows = q
    ? await dbAll(env, 'SELECT * FROM customers WHERE tenant_id = ? AND (name LIKE ? OR phone LIKE ?) ORDER BY created_at DESC', auth.tenantId, `%${q}%`, `%${q}%`)
    : await dbAll(env, 'SELECT * FROM customers WHERE tenant_id = ? ORDER BY created_at DESC', auth.tenantId);
  return json(rows);
}

async function handleCreateCustomer(request, env, auth) {
  const body = await readJson(request);
  if (!body.name) throw new HttpError(400, 'name is required');
  const customerId = id();
  const portalToken = id();
  await dbRun(env,
    `INSERT INTO customers (id, tenant_id, name, phone, email, address, lat, lng, notes, portal_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    customerId, auth.tenantId, body.name, body.phone || null, body.email || null, body.address || null, body.lat ?? null, body.lng ?? null, body.notes || null, portalToken, nowIso());
  return json(await dbGet(env, 'SELECT * FROM customers WHERE id = ?', customerId), 201);
}

async function handleImportCustomers(request, env, auth) {
  requireRole(auth, 'manager');
  const contentType = request.headers.get('Content-Type') || '';
  let rows;
  if (contentType.includes('application/json')) {
    const body = await readJson(request);
    rows = body.rows || [];
  } else {
    rows = parseCsv(await request.text());
  }
  let created = 0, skipped = 0;
  for (const r of rows) {
    const name = r.name || r.Name;
    if (!name) { skipped++; continue; }
    await dbRun(env,
      `INSERT INTO customers (id, tenant_id, name, phone, email, address, portal_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id(), auth.tenantId, name, r.phone || r.Phone || null, r.email || r.Email || null, r.address || r.Address || null, id(), nowIso());
    created++;
  }
  return json({ created, skipped, total: rows.length });
}

async function handleExportCustomers(request, env, auth) {
  requireRole(auth, 'manager');
  const rows = await dbAll(env, 'SELECT * FROM customers WHERE tenant_id = ? ORDER BY created_at', auth.tenantId);
  return csv(rows, ['id', 'name', 'phone', 'email', 'address', 'notes', 'created_at'], 'customers.csv');
}

async function handleGetCustomer(request, env, auth, params) {
  const row = await dbGet(env, 'SELECT * FROM customers WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!row) throw new HttpError(404, 'Customer not found');
  const jobs = await dbAll(env, 'SELECT * FROM jobs WHERE customer_id = ? ORDER BY created_at DESC', params.id);
  return json({ ...row, jobs });
}

async function handlePatchCustomer(request, env, auth, params) {
  const target = await dbGet(env, 'SELECT id FROM customers WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!target) throw new HttpError(404, 'Customer not found');
  const body = await readJson(request);
  const fields = ['name', 'phone', 'email', 'address', 'lat', 'lng', 'notes'];
  const sets = [], binds = [];
  for (const f of fields) if (body[f] !== undefined) { sets.push(`${f} = ?`); binds.push(body[f]); }
  if (!sets.length) return json(await dbGet(env, 'SELECT * FROM customers WHERE id = ?', params.id));
  binds.push(params.id, auth.tenantId);
  await dbRun(env, `UPDATE customers SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, ...binds);
  return json(await dbGet(env, 'SELECT * FROM customers WHERE id = ?', params.id));
}

async function handleDeleteCustomer(request, env, auth, params) {
  requireRole(auth, 'manager');
  await dbRun(env, 'DELETE FROM customers WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  return json({ ok: true });
}

// ═══════════════════════════════ JOBS ═══════════════════════════════

const JOB_STATUSES = ['requested', 'scheduled', 'en_route', 'in_progress', 'completed', 'cancelled'];

async function logJobStatus(env, jobId, status, changedBy, note) {
  await dbRun(env, `INSERT INTO job_status_history (id, job_id, status, changed_by, note, changed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id(), jobId, status, changedBy, note || null, nowIso());
}

async function handleListJobs(request, env, auth) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const staffId = url.searchParams.get('staff_id');
  let sql = 'SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS staff_name FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN users u ON u.id = j.assigned_staff_id WHERE j.tenant_id = ?';
  const binds = [auth.tenantId];
  if (status) { sql += ' AND j.status = ?'; binds.push(status); }
  if (staffId) { sql += ' AND j.assigned_staff_id = ?'; binds.push(staffId); }
  sql += ' ORDER BY j.scheduled_start IS NULL, j.scheduled_start';
  return json(await dbAll(env, sql, ...binds));
}

async function handleMyJobs(request, env, auth) {
  const url = new URL(request.url);
  const dateFrom = url.searchParams.get('from') || new Date().toISOString().slice(0, 10);
  const rows = await dbAll(env,
    `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address
     FROM jobs j JOIN customers c ON c.id = j.customer_id
     WHERE j.tenant_id = ? AND j.assigned_staff_id = ? AND j.status != 'cancelled'
       AND (j.scheduled_start IS NULL OR j.scheduled_start >= ?)
     ORDER BY j.scheduled_start IS NULL, j.scheduled_start`,
    auth.tenantId, auth.user.id, dateFrom);
  return json(rows);
}

async function handleCreateJob(request, env, auth) {
  const body = await readJson(request);
  if (!body.customer_id || !body.title) throw new HttpError(400, 'customer_id and title are required');
  const customer = await dbGet(env, 'SELECT id FROM customers WHERE id = ? AND tenant_id = ?', body.customer_id, auth.tenantId);
  if (!customer) throw new HttpError(404, 'Customer not found');

  const jobId = id();
  const status = body.status && JOB_STATUSES.includes(body.status) ? body.status : 'requested';
  await dbRun(env,
    `INSERT INTO jobs (id, tenant_id, customer_id, assigned_staff_id, title, description, status, scheduled_start, scheduled_end, address, lat, lng, price_estimate, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    jobId, auth.tenantId, body.customer_id, body.assigned_staff_id || null, body.title, body.description || null, status,
    body.scheduled_start || null, body.scheduled_end || null, body.address || null, body.lat ?? null, body.lng ?? null,
    body.price_estimate ?? null, auth.user.id, nowIso(), nowIso());
  await logJobStatus(env, jobId, status, auth.user.id, 'Job created');
  return json(await dbGet(env, 'SELECT * FROM jobs WHERE id = ?', jobId), 201);
}

async function handleGetJob(request, env, auth, params) {
  const job = await dbGet(env,
    `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address
     FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = ? AND j.tenant_id = ?`,
    params.id, auth.tenantId);
  if (!job) throw new HttpError(404, 'Job not found');
  if (auth.role === 'staff' && job.assigned_staff_id !== auth.user.id) throw new HttpError(403, 'Not your job');
  const history = await dbAll(env, 'SELECT * FROM job_status_history WHERE job_id = ? ORDER BY changed_at', params.id);
  const checkins = await dbAll(env, 'SELECT * FROM gps_checkins WHERE job_id = ? ORDER BY recorded_at', params.id);
  const partsUsed = await dbAll(env, 'SELECT jp.*, p.name AS part_name FROM job_parts_used jp JOIN parts_inventory p ON p.id = jp.part_id WHERE jp.job_id = ?', params.id);
  return json({ ...job, history, checkins, parts_used: partsUsed });
}

const STAFF_ALLOWED_STATUSES = new Set(['en_route', 'in_progress', 'completed']);

async function handlePatchJob(request, env, auth, params) {
  const job = await dbGet(env, 'SELECT * FROM jobs WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!job) throw new HttpError(404, 'Job not found');
  if (auth.role === 'staff' && job.assigned_staff_id !== auth.user.id) throw new HttpError(403, 'Not your job');

  const body = await readJson(request);
  const sets = ['updated_at = ?'], binds = [nowIso()];

  if (body.status !== undefined) {
    if (!JOB_STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid status');
    if (auth.role === 'staff' && !STAFF_ALLOWED_STATUSES.has(body.status)) throw new HttpError(403, 'Staff can only set en_route / in_progress / completed');
    sets.push('status = ?'); binds.push(body.status);
  }
  if (auth.role !== 'staff') {
    for (const f of ['title', 'description', 'scheduled_start', 'scheduled_end', 'address', 'lat', 'lng', 'price_estimate', 'assigned_staff_id']) {
      if (body[f] !== undefined) { sets.push(`${f} = ?`); binds.push(body[f]); }
    }
  }
  binds.push(params.id, auth.tenantId);
  await dbRun(env, `UPDATE jobs SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, ...binds);
  if (body.status !== undefined) await logJobStatus(env, params.id, body.status, auth.user.id, body.note || null);
  return json(await dbGet(env, 'SELECT * FROM jobs WHERE id = ?', params.id));
}

async function computeCancellationFee(tenant, job) {
  if (!job.scheduled_start) return 0;
  const hoursUntil = (new Date(job.scheduled_start) - new Date()) / (1000 * 60 * 60);
  if (hoursUntil > tenant.cancellation_window_hours) return 0;
  if (tenant.cancellation_fee_type === 'percent') {
    return round2((job.price_estimate || 0) * (tenant.cancellation_fee_value || 0) / 100);
  }
  return round2(tenant.cancellation_fee_value || 0);
}

async function handleCancelJob(request, env, auth, params) {
  const job = await dbGet(env, 'SELECT * FROM jobs WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!job) throw new HttpError(404, 'Job not found');
  if (job.status === 'cancelled' || job.status === 'completed') throw new HttpError(400, `Job already ${job.status}`);
  const tenant = await requireTenant(env, auth.tenantId);
  const body = await readJson(request);
  const fee = await computeCancellationFee(tenant, job);
  await dbRun(env, `UPDATE jobs SET status = 'cancelled', cancellation_fee_charged = ?, cancelled_reason = ?, updated_at = ? WHERE id = ?`,
    fee, body.reason || null, nowIso(), params.id);
  await logJobStatus(env, params.id, 'cancelled', auth.user.id, body.reason || null);
  return json({ ok: true, cancellation_fee_charged: fee });
}

async function handleCheckin(request, env, auth, params) {
  return recordGpsEvent(request, env, auth, params, 'check_in');
}
async function handleCheckout(request, env, auth, params) {
  return recordGpsEvent(request, env, auth, params, 'check_out');
}

async function recordGpsEvent(request, env, auth, params, type) {
  const job = await dbGet(env, 'SELECT * FROM jobs WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!job) throw new HttpError(404, 'Job not found');
  if (job.assigned_staff_id !== auth.user.id && auth.role === 'staff') throw new HttpError(403, 'Not your job');
  const body = await readJson(request);
  if (body.lat === undefined || body.lng === undefined) throw new HttpError(400, 'lat and lng are required');

  await dbRun(env, `INSERT INTO gps_checkins (id, job_id, staff_id, type, lat, lng, accuracy_m, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id(), params.id, auth.user.id, type, body.lat, body.lng, body.accuracy_m ?? null, nowIso());

  const newStatus = type === 'check_in' ? 'in_progress' : job.status;
  if (type === 'check_in' && job.status !== 'in_progress') {
    await dbRun(env, `UPDATE jobs SET status = 'in_progress', updated_at = ? WHERE id = ?`, nowIso(), params.id);
    await logJobStatus(env, params.id, 'in_progress', auth.user.id, 'GPS check-in');
  }
  return json({ ok: true, type, status: newStatus });
}

async function handleLogJobPart(request, env, auth, params) {
  const job = await dbGet(env, 'SELECT * FROM jobs WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!job) throw new HttpError(404, 'Job not found');
  const body = await readJson(request);
  if (!body.part_id || !body.qty) throw new HttpError(400, 'part_id and qty are required');
  const part = await dbGet(env, 'SELECT * FROM parts_inventory WHERE id = ? AND tenant_id = ?', body.part_id, auth.tenantId);
  if (!part) throw new HttpError(404, 'Part not found');

  await dbRun(env, `INSERT INTO job_parts_used (id, job_id, part_id, qty, unit_cost, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id(), params.id, body.part_id, body.qty, part.unit_cost, nowIso());
  await dbRun(env, `UPDATE parts_inventory SET qty_on_hand = qty_on_hand - ? WHERE id = ?`, body.qty, body.part_id);
  return json({ ok: true }, 201);
}

async function handleExportJobs(request, env, auth) {
  requireRole(auth, 'manager');
  const rows = await dbAll(env,
    `SELECT j.id, j.title, j.status, j.scheduled_start, j.price_estimate, j.cancellation_fee_charged, c.name AS customer_name, u.name AS staff_name
     FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN users u ON u.id = j.assigned_staff_id
     WHERE j.tenant_id = ? ORDER BY j.created_at DESC`, auth.tenantId);
  return csv(rows, ['id', 'title', 'status', 'scheduled_start', 'price_estimate', 'cancellation_fee_charged', 'customer_name', 'staff_name'], 'jobs.csv');
}

// ═══════════════════════════════ QUOTES ═══════════════════════════════

async function handleListQuotes(request, env, auth) {
  return json(await dbAll(env,
    `SELECT q.*, c.name AS customer_name FROM quotes q JOIN customers c ON c.id = q.customer_id WHERE q.tenant_id = ? ORDER BY q.created_at DESC`,
    auth.tenantId));
}

async function handleCreateQuote(request, env, auth) {
  const body = await readJson(request);
  if (!body.customer_id || !Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'customer_id and items[] are required');
  const tenant = await requireTenant(env, auth.tenantId);
  const taxRate = body.tax_rate ?? tenant.tax_rate;
  const { subtotal, taxAmount, total } = computeTotals(body.items, taxRate);

  const quoteId = id();
  await dbRun(env,
    `INSERT INTO quotes (id, tenant_id, customer_id, job_id, status, subtotal, tax_rate, tax_amount, total, currency, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    quoteId, auth.tenantId, body.customer_id, body.job_id || null, subtotal, taxRate, taxAmount, total, tenant.currency, body.notes || null, auth.user.id, nowIso(), nowIso());
  for (const it of body.items) {
    await dbRun(env, `INSERT INTO quote_items (id, quote_id, description, qty, unit_price, total) VALUES (?, ?, ?, ?, ?, ?)`,
      id(), quoteId, it.description, it.qty, it.unit_price, round2(it.qty * it.unit_price));
  }
  return json(await dbGet(env, 'SELECT * FROM quotes WHERE id = ?', quoteId), 201);
}

async function handleGetQuote(request, env, auth, params) {
  const quote = await dbGet(env, 'SELECT * FROM quotes WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!quote) throw new HttpError(404, 'Quote not found');
  const items = await dbAll(env, 'SELECT * FROM quote_items WHERE quote_id = ?', params.id);
  return json({ ...quote, items });
}

async function handlePatchQuote(request, env, auth, params) {
  const quote = await dbGet(env, 'SELECT * FROM quotes WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!quote) throw new HttpError(404, 'Quote not found');
  if (quote.status !== 'draft') throw new HttpError(400, 'Only draft quotes can be edited');
  const body = await readJson(request);
  if (Array.isArray(body.items) && body.items.length) {
    await dbRun(env, 'DELETE FROM quote_items WHERE quote_id = ?', params.id);
    const { subtotal, taxAmount, total } = computeTotals(body.items, body.tax_rate ?? quote.tax_rate);
    for (const it of body.items) {
      await dbRun(env, `INSERT INTO quote_items (id, quote_id, description, qty, unit_price, total) VALUES (?, ?, ?, ?, ?, ?)`,
        id(), params.id, it.description, it.qty, it.unit_price, round2(it.qty * it.unit_price));
    }
    await dbRun(env, `UPDATE quotes SET subtotal = ?, tax_amount = ?, total = ?, tax_rate = ?, updated_at = ? WHERE id = ?`,
      subtotal, taxAmount, total, body.tax_rate ?? quote.tax_rate, nowIso(), params.id);
  }
  if (body.notes !== undefined) await dbRun(env, 'UPDATE quotes SET notes = ? WHERE id = ?', body.notes, params.id);
  return json(await dbGet(env, 'SELECT * FROM quotes WHERE id = ?', params.id));
}

async function handleSendQuote(request, env, auth, params) {
  const quote = await dbGet(env, 'SELECT * FROM quotes WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!quote) throw new HttpError(404, 'Quote not found');
  await dbRun(env, `UPDATE quotes SET status = 'sent', updated_at = ? WHERE id = ?`, nowIso(), params.id);
  return json({ ok: true, status: 'sent' });
}

async function handleDeclineQuote(request, env, auth, params) {
  await dbRun(env, `UPDATE quotes SET status = 'declined', updated_at = ? WHERE id = ? AND tenant_id = ?`, nowIso(), params.id, auth.tenantId);
  return json({ ok: true, status: 'declined' });
}

async function handleAcceptQuote(request, env, auth, params) {
  const quote = await dbGet(env, 'SELECT * FROM quotes WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!quote) throw new HttpError(404, 'Quote not found');
  const items = await dbAll(env, 'SELECT * FROM quote_items WHERE quote_id = ?', params.id);

  const invoiceId = id();
  await dbRun(env,
    `INSERT INTO invoices (id, tenant_id, customer_id, job_id, quote_id, status, subtotal, tax_rate, tax_amount, total, currency, due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?)`,
    invoiceId, auth.tenantId, quote.customer_id, quote.job_id, quote.id, quote.subtotal, quote.tax_rate, quote.tax_amount, quote.total, quote.currency,
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), nowIso(), nowIso());
  for (const it of items) {
    await dbRun(env, `INSERT INTO invoice_items (id, invoice_id, description, qty, unit_price, total) VALUES (?, ?, ?, ?, ?, ?)`,
      id(), invoiceId, it.description, it.qty, it.unit_price, it.total);
  }
  await dbRun(env, `UPDATE quotes SET status = 'accepted', updated_at = ? WHERE id = ?`, nowIso(), params.id);
  return json({ ok: true, invoice_id: invoiceId }, 201);
}

// ═══════════════════════════════ INVOICES / PAYMENTS ═══════════════════════════════

async function handleListInvoices(request, env, auth) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  let sql = `SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.tenant_id = ?`;
  const binds = [auth.tenantId];
  if (status) { sql += ' AND i.status = ?'; binds.push(status); }
  sql += ' ORDER BY i.created_at DESC';
  return json(await dbAll(env, sql, ...binds));
}

async function handleCreateInvoice(request, env, auth) {
  const body = await readJson(request);
  if (!body.customer_id || !Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'customer_id and items[] are required');
  const tenant = await requireTenant(env, auth.tenantId);
  const taxRate = body.tax_rate ?? tenant.tax_rate;
  const { subtotal, taxAmount, total } = computeTotals(body.items, taxRate);

  const invoiceId = id();
  await dbRun(env,
    `INSERT INTO invoices (id, tenant_id, customer_id, job_id, status, subtotal, tax_rate, tax_amount, total, currency, due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?)`,
    invoiceId, auth.tenantId, body.customer_id, body.job_id || null, subtotal, taxRate, taxAmount, total, tenant.currency,
    body.due_date || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), nowIso(), nowIso());
  for (const it of body.items) {
    await dbRun(env, `INSERT INTO invoice_items (id, invoice_id, description, qty, unit_price, total) VALUES (?, ?, ?, ?, ?, ?)`,
      id(), invoiceId, it.description, it.qty, it.unit_price, round2(it.qty * it.unit_price));
  }
  return json(await dbGet(env, 'SELECT * FROM invoices WHERE id = ?', invoiceId), 201);
}

async function handleGetInvoice(request, env, auth, params) {
  const invoice = await dbGet(env, `SELECT i.*, c.name AS customer_name, c.address AS customer_address FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ? AND i.tenant_id = ?`, params.id, auth.tenantId);
  if (!invoice) throw new HttpError(404, 'Invoice not found');
  const items = await dbAll(env, 'SELECT * FROM invoice_items WHERE invoice_id = ?', params.id);
  const payments = await dbAll(env, 'SELECT * FROM payments WHERE invoice_id = ? ORDER BY paid_at', params.id);
  return json({ ...invoice, items, payments });
}

async function handlePatchInvoice(request, env, auth, params) {
  const invoice = await dbGet(env, 'SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!invoice) throw new HttpError(404, 'Invoice not found');
  const body = await readJson(request);
  const sets = ['updated_at = ?'], binds = [nowIso()];
  for (const f of ['due_date', 'status']) if (body[f] !== undefined) { sets.push(`${f} = ?`); binds.push(body[f]); }
  binds.push(params.id, auth.tenantId);
  await dbRun(env, `UPDATE invoices SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, ...binds);
  return json(await dbGet(env, 'SELECT * FROM invoices WHERE id = ?', params.id));
}

async function handleAddPayment(request, env, auth, params) {
  const invoice = await dbGet(env, 'SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!invoice) throw new HttpError(404, 'Invoice not found');
  const body = await readJson(request);
  if (!body.amount || body.amount <= 0) throw new HttpError(400, 'amount must be a positive number');

  await dbRun(env, `INSERT INTO payments (id, invoice_id, tenant_id, amount, method, reference, recorded_by, paid_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id(), params.id, auth.tenantId, body.amount, body.method || 'cash', body.reference || null, auth.user.id, nowIso(), body.note || null);

  const newPaid = round2((invoice.amount_paid || 0) + body.amount);
  const newStatus = newPaid >= invoice.total ? 'paid' : 'partial';
  await dbRun(env, `UPDATE invoices SET amount_paid = ?, status = ?, paid_at = ?, updated_at = ? WHERE id = ?`,
    newPaid, newStatus, newStatus === 'paid' ? nowIso() : invoice.paid_at, nowIso(), params.id);
  return json({ ok: true, amount_paid: newPaid, status: newStatus }, 201);
}

async function handleExportInvoices(request, env, auth) {
  requireRole(auth, 'manager');
  const rows = await dbAll(env,
    `SELECT i.id, i.status, i.subtotal, i.tax_amount, i.total, i.amount_paid, i.currency, i.due_date, c.name AS customer_name
     FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.tenant_id = ? ORDER BY i.created_at DESC`, auth.tenantId);
  return csv(rows, ['id', 'status', 'subtotal', 'tax_amount', 'total', 'amount_paid', 'currency', 'due_date', 'customer_name'], 'invoices.csv');
}

// ═══════════════════════════════ INVENTORY ═══════════════════════════════

async function handleListParts(request, env, auth) {
  return json(await dbAll(env, 'SELECT * FROM parts_inventory WHERE tenant_id = ? ORDER BY name', auth.tenantId));
}

async function handleCreatePart(request, env, auth) {
  requireRole(auth, 'manager');
  const body = await readJson(request);
  if (!body.name) throw new HttpError(400, 'name is required');
  const partId = id();
  await dbRun(env, `INSERT INTO parts_inventory (id, tenant_id, name, sku, unit_cost, unit_price, qty_on_hand, reorder_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    partId, auth.tenantId, body.name, body.sku || null, body.unit_cost || 0, body.unit_price || 0, body.qty_on_hand || 0, body.reorder_level || 0, nowIso());
  return json(await dbGet(env, 'SELECT * FROM parts_inventory WHERE id = ?', partId), 201);
}

async function handlePatchPart(request, env, auth, params) {
  requireRole(auth, 'manager');
  const target = await dbGet(env, 'SELECT id FROM parts_inventory WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!target) throw new HttpError(404, 'Part not found');
  const body = await readJson(request);
  const fields = ['name', 'sku', 'unit_cost', 'unit_price', 'qty_on_hand', 'reorder_level'];
  const sets = [], binds = [];
  for (const f of fields) if (body[f] !== undefined) { sets.push(`${f} = ?`); binds.push(body[f]); }
  if (!sets.length) return json(await dbGet(env, 'SELECT * FROM parts_inventory WHERE id = ?', params.id));
  binds.push(params.id, auth.tenantId);
  await dbRun(env, `UPDATE parts_inventory SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, ...binds);
  return json(await dbGet(env, 'SELECT * FROM parts_inventory WHERE id = ?', params.id));
}

// ═══════════════════════════════ RECURRING PLANS ═══════════════════════════════

async function handleListRecurringPlans(request, env, auth) {
  return json(await dbAll(env,
    `SELECT r.*, c.name AS customer_name FROM recurring_plans r JOIN customers c ON c.id = r.customer_id WHERE r.tenant_id = ? ORDER BY r.next_run_date`,
    auth.tenantId));
}

async function handleCreateRecurringPlan(request, env, auth) {
  requireRole(auth, 'manager');
  const body = await readJson(request);
  if (!body.customer_id || !body.title || !body.frequency || !body.next_run_date) {
    throw new HttpError(400, 'customer_id, title, frequency, next_run_date are required');
  }
  if (!['weekly', 'biweekly', 'monthly'].includes(body.frequency)) throw new HttpError(400, 'frequency must be weekly, biweekly, or monthly');
  const planId = id();
  await dbRun(env, `INSERT INTO recurring_plans (id, tenant_id, customer_id, title, frequency, amount, next_run_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    planId, auth.tenantId, body.customer_id, body.title, body.frequency, body.amount || 0, body.next_run_date, nowIso());
  return json(await dbGet(env, 'SELECT * FROM recurring_plans WHERE id = ?', planId), 201);
}

async function handlePatchRecurringPlan(request, env, auth, params) {
  requireRole(auth, 'manager');
  const target = await dbGet(env, 'SELECT id FROM recurring_plans WHERE id = ? AND tenant_id = ?', params.id, auth.tenantId);
  if (!target) throw new HttpError(404, 'Recurring plan not found');
  const body = await readJson(request);
  const fields = ['title', 'frequency', 'amount', 'next_run_date', 'active'];
  const sets = [], binds = [];
  for (const f of fields) if (body[f] !== undefined) { sets.push(`${f} = ?`); binds.push(f === 'active' ? (body[f] ? 1 : 0) : body[f]); }
  if (!sets.length) return json(await dbGet(env, 'SELECT * FROM recurring_plans WHERE id = ?', params.id));
  binds.push(params.id, auth.tenantId);
  await dbRun(env, `UPDATE recurring_plans SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, ...binds);
  return json(await dbGet(env, 'SELECT * FROM recurring_plans WHERE id = ?', params.id));
}

function advanceDate(dateStr, frequency) {
  const d = new Date(dateStr);
  if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'biweekly') d.setDate(d.getDate() + 14);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

// Runs daily (see wrangler.toml [triggers]): auto-generates invoices for due recurring plans,
// and flips unpaid invoices past their due_date to 'overdue'.
async function runRecurringBillingSweep(env) {
  const today = new Date().toISOString();
  const dueTenants = await dbAll(env, `SELECT * FROM recurring_plans WHERE active = 1 AND next_run_date <= ?`, today);
  for (const plan of dueTenants) {
    const tenant = await dbGet(env, 'SELECT * FROM tenants WHERE id = ?', plan.tenant_id);
    if (!tenant) continue;
    const { subtotal, taxAmount, total } = computeTotals([{ description: plan.title, qty: 1, unit_price: plan.amount }], tenant.tax_rate);
    const invoiceId = id();
    await dbRun(env,
      `INSERT INTO invoices (id, tenant_id, customer_id, recurring_plan_id, status, subtotal, tax_rate, tax_amount, total, currency, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?)`,
      invoiceId, plan.tenant_id, plan.customer_id, plan.id, subtotal, tenant.tax_rate, taxAmount, total, tenant.currency,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), nowIso(), nowIso());
    await dbRun(env, `INSERT INTO invoice_items (id, invoice_id, description, qty, unit_price, total) VALUES (?, ?, ?, 1, ?, ?)`,
      id(), invoiceId, plan.title, plan.amount, plan.amount);
    await dbRun(env, `UPDATE recurring_plans SET next_run_date = ? WHERE id = ?`, advanceDate(plan.next_run_date, plan.frequency), plan.id);
  }
  await dbRun(env, `UPDATE invoices SET status = 'overdue' WHERE status = 'unpaid' AND due_date IS NOT NULL AND due_date < ?`, today);
}

// ═══════════════════════════════ CUSTOMER SELF-SERVICE PORTAL (public, token-based) ═══════════════════════════════
// No JWT here — the portal_token in the URL IS the credential (mirrors a magic-link pattern).
// A future WhatsApp/SMS/email integration is what would deliver this link to the customer; until
// then, staff copy it from the customer record in owner.html.

async function handlePortalGet(request, env, auth, params) {
  const customer = await dbGet(env, 'SELECT * FROM customers WHERE portal_token = ?', params.token);
  if (!customer) throw new HttpError(404, 'Invalid portal link');
  const tenant = await requireTenant(env, customer.tenant_id);
  const jobs = await dbAll(env, 'SELECT * FROM jobs WHERE customer_id = ? ORDER BY scheduled_start DESC', customer.id);
  const invoices = await dbAll(env, 'SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC', customer.id);
  return json({
    business: { name: tenant.name, currency: tenant.currency },
    customer: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, address: customer.address },
    jobs, invoices,
  });
}

async function handlePortalReschedule(request, env, auth, params) {
  const customer = await dbGet(env, 'SELECT * FROM customers WHERE portal_token = ?', params.token);
  if (!customer) throw new HttpError(404, 'Invalid portal link');
  const job = await dbGet(env, 'SELECT * FROM jobs WHERE id = ? AND customer_id = ?', params.jobId, customer.id);
  if (!job) throw new HttpError(404, 'Booking not found');
  if (!['requested', 'scheduled'].includes(job.status)) throw new HttpError(400, `Cannot reschedule a job that is ${job.status}`);
  const body = await readJson(request);
  if (!body.scheduled_start) throw new HttpError(400, 'scheduled_start is required');
  await dbRun(env, `UPDATE jobs SET scheduled_start = ?, scheduled_end = ?, updated_at = ? WHERE id = ?`,
    body.scheduled_start, body.scheduled_end || null, nowIso(), params.jobId);
  await logJobStatus(env, params.jobId, job.status, null, 'Rescheduled by customer via portal');
  return json({ ok: true });
}

async function handlePortalCancel(request, env, auth, params) {
  const customer = await dbGet(env, 'SELECT * FROM customers WHERE portal_token = ?', params.token);
  if (!customer) throw new HttpError(404, 'Invalid portal link');
  const job = await dbGet(env, 'SELECT * FROM jobs WHERE id = ? AND customer_id = ?', params.jobId, customer.id);
  if (!job) throw new HttpError(404, 'Booking not found');
  if (job.status === 'cancelled' || job.status === 'completed') throw new HttpError(400, `Job already ${job.status}`);
  const tenant = await requireTenant(env, customer.tenant_id);
  const fee = await computeCancellationFee(tenant, job);
  await dbRun(env, `UPDATE jobs SET status = 'cancelled', cancellation_fee_charged = ?, cancelled_reason = 'Cancelled by customer', updated_at = ? WHERE id = ?`,
    fee, nowIso(), params.jobId);
  await logJobStatus(env, params.jobId, 'cancelled', null, 'Cancelled by customer via portal');
  return json({ ok: true, cancellation_fee_charged: fee });
}

// Online payment gateway is not wired up yet — this returns a clear "not configured" response
// instead of pretending to charge a card. Swap the body of this handler for a real Stripe/PayTabs/
// Razorpay call when a gateway is chosen; the route and portal UI are already wired to it.
async function handlePortalPayIntent(request, env, auth, params) {
  const customer = await dbGet(env, 'SELECT * FROM customers WHERE portal_token = ?', params.token);
  if (!customer) throw new HttpError(404, 'Invalid portal link');
  const invoice = await dbGet(env, 'SELECT * FROM invoices WHERE id = ? AND customer_id = ?', params.invoiceId, customer.id);
  if (!invoice) throw new HttpError(404, 'Invoice not found');
  return json({ status: 'not_configured', message: 'Online payment isn’t connected yet — please pay on completion or contact the business directly.' });
}

// ═══════════════════════════════ ROUTER ═══════════════════════════════

const PUBLIC_ROUTES = [
  ['POST', '/api/auth/signup', handleSignup],
  ['POST', '/api/auth/login', handleLogin],
  ['GET', '/api/portal/:token', handlePortalGet],
  ['POST', '/api/portal/:token/jobs/:jobId/reschedule', handlePortalReschedule],
  ['POST', '/api/portal/:token/jobs/:jobId/cancel', handlePortalCancel],
  ['POST', '/api/portal/:token/invoices/:invoiceId/pay-intent', handlePortalPayIntent],
];

const AUTHED_ROUTES = [
  ['GET', '/api/me', handleMe],
  ['GET', '/api/tenant', handleGetTenant],
  ['PATCH', '/api/tenant', handlePatchTenant],

  ['GET', '/api/staff', handleListStaff],
  ['POST', '/api/staff', handleCreateStaff],
  ['PATCH', '/api/staff/:id', handlePatchStaff],
  ['DELETE', '/api/staff/:id', handleDeactivateStaff],

  ['GET', '/api/customers/export', handleExportCustomers],
  ['POST', '/api/customers/import', handleImportCustomers],
  ['GET', '/api/customers', handleListCustomers],
  ['POST', '/api/customers', handleCreateCustomer],
  ['GET', '/api/customers/:id', handleGetCustomer],
  ['PATCH', '/api/customers/:id', handlePatchCustomer],
  ['DELETE', '/api/customers/:id', handleDeleteCustomer],

  ['GET', '/api/jobs/export', handleExportJobs],
  ['GET', '/api/jobs/mine', handleMyJobs],
  ['GET', '/api/jobs', handleListJobs],
  ['POST', '/api/jobs', handleCreateJob],
  ['GET', '/api/jobs/:id', handleGetJob],
  ['PATCH', '/api/jobs/:id', handlePatchJob],
  ['POST', '/api/jobs/:id/cancel', handleCancelJob],
  ['POST', '/api/jobs/:id/checkin', handleCheckin],
  ['POST', '/api/jobs/:id/checkout', handleCheckout],
  ['POST', '/api/jobs/:id/parts', handleLogJobPart],

  ['GET', '/api/quotes', handleListQuotes],
  ['POST', '/api/quotes', handleCreateQuote],
  ['GET', '/api/quotes/:id', handleGetQuote],
  ['PATCH', '/api/quotes/:id', handlePatchQuote],
  ['POST', '/api/quotes/:id/send', handleSendQuote],
  ['POST', '/api/quotes/:id/accept', handleAcceptQuote],
  ['POST', '/api/quotes/:id/decline', handleDeclineQuote],

  ['GET', '/api/invoices/export', handleExportInvoices],
  ['GET', '/api/invoices', handleListInvoices],
  ['POST', '/api/invoices', handleCreateInvoice],
  ['GET', '/api/invoices/:id', handleGetInvoice],
  ['PATCH', '/api/invoices/:id', handlePatchInvoice],
  ['POST', '/api/invoices/:id/payments', handleAddPayment],

  ['GET', '/api/parts', handleListParts],
  ['POST', '/api/parts', handleCreatePart],
  ['PATCH', '/api/parts/:id', handlePatchPart],

  ['GET', '/api/recurring-plans', handleListRecurringPlans],
  ['POST', '/api/recurring-plans', handleCreateRecurringPlan],
  ['PATCH', '/api/recurring-plans/:id', handlePatchRecurringPlan],
];

function matchRoute(routes, method, pathname) {
  const reqParts = pathname.split('/').filter(Boolean);
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const patParts = pattern.split('/').filter(Boolean);
    if (patParts.length !== reqParts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < patParts.length; i++) {
      if (patParts[i].startsWith(':')) params[patParts[i].slice(1)] = decodeURIComponent(reqParts[i]);
      else if (patParts[i] !== reqParts[i]) { matched = false; break; }
    }
    if (matched) return { handler, params };
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      const pub = matchRoute(PUBLIC_ROUTES, request.method, url.pathname);
      if (pub) {
        const result = await pub.handler(request, env, {}, pub.params);
        return withCors(result, cors);
      }

      const authedMatch = matchRoute(AUTHED_ROUTES, request.method, url.pathname);
      if (authedMatch) {
        const auth = await authenticate(request, env);
        const result = await authedMatch.handler(request, env, auth, authedMatch.params);
        return withCors(result, cors);
      }

      return withCors(json({ error: 'Not found' }, 404), cors);
    } catch (err) {
      if (err instanceof HttpError) return withCors(json({ error: err.message }, err.status), cors);
      console.error('Unhandled error:', err);
      return withCors(json({ error: 'Internal server error' }, 500), cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRecurringBillingSweep(env));
  },
};

function withCors(response, cors) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}
