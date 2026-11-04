import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLiveDemo, targetBox } from '../lib/live-demo.js';

test('public analysis starts immediately, shares pending work, and returns real provider results when ready', async () => {
  const { promise, resolve } = Promise.withResolvers();
  let plans = 0;
  let tracks = 0;
  const demo = createLiveDemo({
    async plan() {
      plans++;
      await promise;
      return { hide: 'stop sign', preserve: 'orange traffic cone' };
    },
    async track() {
      tracks++;
      await promise;
      return Array.from({ length: 36 }, (_, index) => ({ box: targetBox(index), state: 'suggested' }));
    },
  }, fileURLToPath(new URL('../media/live-sample.mp4', import.meta.url)), (status, message) => Object.assign(new Error(message), { status }));

  try {
    const first = demo.startAnalysis();
    assert.equal(first.shared, false);
    assert.deepEqual(demo.getAnalysis(first.id), { status: 'running', result: undefined });
    assert.deepEqual(demo.startAnalysis(), { id: first.id, shared: true });
    assert.throws(() => demo.getAnalysis('missing'), { status: 404 });
    await demo.getSample();
    resolve();
    await new Promise(setImmediate);
    const { status, result } = demo.getAnalysis(first.id);
    assert.equal(status, 'complete');
    assert.equal(result.matched, 36);
    assert.equal(result.plan.hide, 'stop sign');
    assert.equal(result.frames[35].state, 'suggested');
    assert.deepEqual(demo.startAnalysis(), { id: first.id, shared: true });
    assert.equal(plans, 1);
    assert.equal(tracks, 1);
  } finally {
    resolve();
    await demo.close();
  }
});
