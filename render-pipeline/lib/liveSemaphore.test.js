const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveSemaphore } = require('./liveSemaphore');

test('live semaphore admits only two AI4Bharat jobs and never queues overflow', () => {
  const semaphore = createLiveSemaphore(2);
  assert.equal(semaphore.tryAcquire(), true);
  assert.equal(semaphore.tryAcquire(), true);
  assert.equal(semaphore.tryAcquire(), false);
  assert.equal(semaphore.active, 2);
  semaphore.release();
  assert.equal(semaphore.tryAcquire(), true);
  assert.equal(semaphore.active, 2);
});
