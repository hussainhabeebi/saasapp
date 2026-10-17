// Baby Care: "Order Taken By" on every order + staff-wise order report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ecomStaffTakenBy, ecomSystemTakenBy, ecomStaffOrderReport, ECOM_TAKEN_BY_BOT, ECOM_TAKEN_BY_STORE } from './worker.js';

const c = { authentik_email: 'owner@shop.in', team_names: JSON.stringify({ 'Riya@Shop.in': 'Riya', 'sam@shop.in': 'Sam' }) };
const NOW = new Date('2026-10-17T10:00:00Z');

test('staff name comes from User Management, owner and unnamed logins still get a name', () => {
  assert.deepEqual(ecomStaffTakenBy(c, ' RIYA@shop.in ', NOW), { taken_by: 'riya@shop.in', taken_by_name: 'Riya', taken_by_at: '2026-10-17T10:00:00.000Z' });
  assert.equal(ecomStaffTakenBy(c, 'owner@shop.in').taken_by_name, 'Owner');
  assert.equal(ecomStaffTakenBy(c, 'new.hire@shop.in').taken_by_name, 'new.hire');
  assert.equal(ecomStaffTakenBy(c, ''), null);
});

test('bot and store-page orders are labelled as such', () => {
  assert.equal(ecomSystemTakenBy(ECOM_TAKEN_BY_BOT).taken_by, 'ai_bot');
  assert.match(ecomSystemTakenBy(ECOM_TAKEN_BY_BOT).taken_by_name, /AI bot/);
  assert.match(ecomSystemTakenBy(ECOM_TAKEN_BY_STORE).taken_by_name, /Store page/);
});

test('staff report: orders per staff, drafts skipped, cancelled counted apart, date range', () => {
  const orders = [
    { order_date: '2026-10-15', status: 'pending', total: 500, taken_by: 'riya@shop.in', taken_by_name: 'Riya' },
    { order_date: '2026-10-16', status: 'delivered', total: 700, taken_by: 'riya@shop.in', taken_by_name: 'Riya' },
    { order_date: '2026-10-16', status: 'cancelled', total: 300, taken_by: 'riya@shop.in', taken_by_name: 'Riya' },
    { order_date: '2026-10-16', status: 'received', total: 900, taken_by: 'sam@shop.in', taken_by_name: 'Sam' },
    { order_date: '2026-10-16', status: 'draft', total: 100, taken_by: '' },
    { order_date: '2026-10-10', status: 'pending', total: 100, taken_by: 'ai_bot', taken_by_name: 'AI bot (WhatsApp chat)' },
    { order_date: '2026-10-12', status: 'shipped', total: 50 },
  ];
  const all = ecomStaffOrderReport(orders);
  assert.equal(all.total_orders, 5);
  assert.deepEqual(all.rows.map(r => [r.name, r.orders]), [['Riya', 2], ['AI bot (WhatsApp chat)', 1], ['Not recorded', 1], ['Sam', 1]]);
  const riya = all.rows[0];
  assert.equal(riya.revenue, 1200);
  assert.equal(riya.cancelled, 1);
  assert.deepEqual(riya.by_status, { pending: 1, delivered: 1, cancelled: 1 });
  assert.equal(riya.first_day, '2026-10-15');
  assert.equal(riya.last_day, '2026-10-16');
  const day = ecomStaffOrderReport(orders, { from: '2026-10-16', to: '2026-10-16' });
  assert.equal(day.total_orders, 2);
  assert.deepEqual(day.rows.map(r => [r.taken_by, r.orders]), [['riya@shop.in', 1], ['sam@shop.in', 1]]);
});

import { ecomAssignFields, ecomTeamList, ecomTeamEmails, ecomAssignedOrderReport } from './worker.js';

test('order assignment: team list (owner first, on-leave flagged) and assignment fields', () => {
  const cc = { ...c, team_emails: 'riya@shop.in,sam@shop.in', bot_config: JSON.stringify({ ecom_communication_style: 'baby_care' }),
    lead_routing: JSON.stringify({ rules: { 'sam@shop.in': { onLeave: true } } }) };
  assert.deepEqual([...ecomTeamEmails(cc)].sort(), ['owner@shop.in', 'riya@shop.in', 'sam@shop.in']);
  const list = ecomTeamList(cc);
  assert.equal(list[0].email, 'owner@shop.in');
  assert.equal(list.find(m => m.email === 'sam@shop.in').on_leave, true);
  assert.deepEqual(ecomAssignFields(cc, 'Riya@shop.in', 'owner@shop.in', NOW),
    { assigned_to: 'riya@shop.in', assigned_to_name: 'Riya', assigned_at: '2026-10-17T10:00:00.000Z', assigned_by: 'owner@shop.in' });
  assert.equal(ecomAssignFields(cc, '', 'owner@shop.in', NOW).assigned_to, '');
});

test('assigned-orders report: open vs done per teammate, unassigned last', () => {
  const rows = ecomAssignedOrderReport([
    { order_date: '2026-10-16', status: 'pending', assigned_to: 'riya@shop.in', assigned_to_name: 'Riya' },
    { order_date: '2026-10-16', status: 'draft', assigned_to: 'riya@shop.in', assigned_to_name: 'Riya' },
    { order_date: '2026-10-16', status: 'delivered', assigned_to: 'riya@shop.in', assigned_to_name: 'Riya' },
    { order_date: '2026-10-16', status: 'cancelled', assigned_to: 'riya@shop.in', assigned_to_name: 'Riya' },
    { order_date: '2026-10-16', status: 'shipped', assigned_to: 'sam@shop.in', assigned_to_name: 'Sam' },
    { order_date: '2026-10-16', status: 'pending' },
    { order_date: '2026-09-01', status: 'pending', assigned_to: 'sam@shop.in' },
  ], { from: '2026-10-01' });
  assert.deepEqual(rows.map(r => [r.name, r.total, r.open, r.done, r.cancelled]),
    [['Riya', 3, 2, 1, 1], ['Sam', 1, 0, 1, 0], ['Unassigned', 1, 1, 0, 0]]);
});
