// After a booking the customer gets the full appointment details, then the clinic's location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apptConfirmationText, apptFormatDate, apptFormatTime } from './worker.js';

test('formats appointment date and time for customers', () => {
  assert.equal(apptFormatDate('2026-10-07'), 'Wed, 7 Oct 2026');
  assert.equal(apptFormatTime('14:30'), '2:30 PM');
  assert.equal(apptFormatTime('00:05'), '12:05 AM');
  assert.equal(apptFormatTime('12:00'), '12:00 PM');
  assert.equal(apptFormatDate('soon'), 'soon');
});

test('confirmation lists clinic, service, doctor, date, time and name', () => {
  const text = apptConfirmationText({ businessName: 'City Clinic', patientName: 'Asha', serviceName: 'Dental Cleaning',
    doctorName: 'Dr. Rao', date: '2026-10-07', time: '09:15', confirmed: false });
  for (const part of ['Hi Asha', 'received at *City Clinic*', '*Service:* Dental Cleaning', '*Doctor:* Dr. Rao',
    '*Date:* Wed, 7 Oct 2026', '*Time:* 9:15 AM', '*Name:* Asha', 'confirm your appointment shortly']) assert.ok(text.includes(part), part);
});

test('confirmed appointments and missing fields', () => {
  const text = apptConfirmationText({ date: '2026-10-07', time: '18:00', confirmed: true });
  assert.ok(text.startsWith('Hi there! ✅ Your appointment has been confirmed.'));
  assert.ok(!text.includes('Doctor:'));
  assert.ok(text.includes('arrive 10 minutes early'));
});
