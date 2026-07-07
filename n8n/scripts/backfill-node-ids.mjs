#!/usr/bin/env node
// Repairs per-client n8n workflows provisioned before the node-id fix in
// n8n/onboard.json (Code · Build wrapper). Those workflows were created via
// the n8n API with nodes missing the required `id` field, which crashes the
// client's webhook on first call with:
//   TypeError: Cannot read properties of undefined (reading 'name')
//     at WebhookContext.getChildNodes ... checkResponseModeConfiguration
//
// For every client row in NocoDB that already has an n8n_workflow_id, this
// fetches the workflow, backfills a unique id on any node missing one, and
// (if changed) pushes the update and cycles activation so n8n re-registers
// the webhook route.
//
// Usage:
//   N8N_BASE=https://apps.leadvyne.com \
//   N8N_API_HEADER_NAME=X-N8N-API-KEY \
//   N8N_API_HEADER_VALUE=... \
//   NOCODB_BASE=https://whizz.aiingo.com \
//   NOCODB_TOKEN=... \
//   CLIENTS_TABLE_ID=mxl33bg4wi70fqj \
//   node n8n/scripts/backfill-node-ids.mjs [--apply]
//
// Without --apply this only reports which clients' workflows are affected.
// Pass --apply to actually patch and reactivate them.

const {
  N8N_BASE,
  N8N_API_HEADER_NAME = 'X-N8N-API-KEY',
  N8N_API_HEADER_VALUE,
  NOCODB_BASE,
  NOCODB_TOKEN,
  CLIENTS_TABLE_ID,
} = process.env;

const APPLY = process.argv.includes('--apply');

function requireEnv() {
  const missing = ['N8N_BASE', 'N8N_API_HEADER_VALUE', 'NOCODB_BASE', 'NOCODB_TOKEN', 'CLIENTS_TABLE_ID']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Missing required env vars:', missing.join(', '));
    process.exit(1);
  }
}

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

async function nocodbFetch(path) {
  const res = await fetch(`${NOCODB_BASE.replace(/\/$/, '')}${path}`, {
    headers: { 'xc-token': NOCODB_TOKEN },
  });
  if (!res.ok) throw new Error(`NocoDB ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function n8nFetch(path, options = {}) {
  const res = await fetch(`${N8N_BASE.replace(/\/$/, '')}${path}`, {
    ...options,
    headers: {
      [N8N_API_HEADER_NAME]: N8N_API_HEADER_VALUE,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`n8n ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function fetchAllClients() {
  const clients = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const page = await nocodbFetch(
      `/api/v2/tables/${CLIENTS_TABLE_ID}/records?limit=${limit}&offset=${offset}`,
    );
    const rows = page.list || [];
    clients.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
  }
  return clients.filter((r) => r.n8n_workflow_id);
}

function backfillIds(workflow) {
  let changed = false;
  const nodes = workflow.nodes.map((node) => {
    if (node.id) return node;
    changed = true;
    return { id: genId(), ...node };
  });
  return { changed, nodes };
}

async function repairWorkflow(workflowId) {
  const workflow = await n8nFetch(`/api/v1/workflows/${workflowId}`);
  const { changed, nodes } = backfillIds(workflow);
  if (!changed) return { workflowId, status: 'ok (already has ids)' };

  if (!APPLY) return { workflowId, status: 'needs fix (dry run)' };

  await n8nFetch(`/api/v1/workflows/${workflowId}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: workflow.name,
      nodes,
      connections: workflow.connections,
      settings: workflow.settings || {},
    }),
  });

  // Cycle activation so the webhook route is re-registered against the
  // corrected node graph (matches known n8n behavior where an in-place
  // update of an already-active workflow doesn't always re-register webhooks).
  await n8nFetch(`/api/v1/workflows/${workflowId}/deactivate`, { method: 'POST' });
  await n8nFetch(`/api/v1/workflows/${workflowId}/activate`, { method: 'POST' });

  return { workflowId, status: 'fixed' };
}

async function main() {
  requireEnv();
  const clients = await fetchAllClients();
  console.log(`Found ${clients.length} client(s) with a provisioned workflow.`);
  console.log(APPLY ? 'Mode: APPLY (will patch + reactivate)' : 'Mode: DRY RUN (pass --apply to fix)');

  const results = [];
  for (const client of clients) {
    const workflowId = client.n8n_workflow_id;
    try {
      const result = await repairWorkflow(workflowId);
      results.push({ clientId: client.Id, ...result });
    } catch (err) {
      results.push({ clientId: client.Id, workflowId, status: `error: ${err.message}` });
    }
  }

  console.table(results);
  const broken = results.filter((r) => r.status.startsWith('needs fix'));
  const fixed = results.filter((r) => r.status === 'fixed');
  const errored = results.filter((r) => r.status.startsWith('error'));
  console.log(
    `\n${fixed.length} fixed, ${broken.length} still need --apply, ${errored.length} errored.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
