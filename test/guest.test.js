import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('name-only sessions keep uploaded clips and live analysis isolated', async () => {
  process.env.SHARESAFE_GUEST_MODE = '1';
  process.env.META_MODEL_API_KEY = 'test-only';
  process.env.SHARESAFE_DEMO_PASSWORD = 'legacy-test-only';
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (url !== 'https://api.meta.ai/v1/responses') return nativeFetch(url, options);
    return Promise.resolve(new Response([
      'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: '{"hide":"stop sign","preserve":"orange cone"}' }),
      'data: ' + JSON.stringify({ type: 'response.completed' }),
      '',
    ].join('\n\n'), { headers: { 'Content-Type': 'text/event-stream' } }));
  };
  const { start } = await import('../server.js');
  const server = start(0, '127.0.0.1');
  await once(server, 'listening');
  const call = (path, options) => nativeFetch('http://127.0.0.1:' + server.address().port + path, options);
  async function enter() {
    const response = await call('/login', { method: 'POST', body: new URLSearchParams({ name: 'Same Name' }), redirect: 'manual' });
    assert.equal(response.status, 303);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /^sharesafe_guest=.*HttpOnly.*SameSite=Strict/);
    return cookie.split(';')[0];
  }

  try {
    const form = await (await call('/')).text();
    assert.match(form, /name="name"/);
    assert.doesNotMatch(form, /name="password"/);
    assert.equal((await call('/api/status')).status, 401);
    const first = await enter();
    const second = await enter();
    assert.notEqual(first, second);
    const clip = await readFile(new URL('../media/live-sample.mp4', import.meta.url));
    const upload = await call('/api/upload', { method: 'POST', body: clip, headers: { cookie: first } });
    assert.equal(upload.status, 201);
    const { id, background } = await upload.json();
    assert.equal(background, true);
    const path = '/api/jobs/' + id;
    assert.equal((await call(path + '/frame/0', { headers: { cookie: first } })).status, 200);
    assert.equal((await call(path + '/frame/0', { headers: { cookie: second } })).status, 404);
    assert.equal((await call(path, { method: 'DELETE', headers: { cookie: second } })).status, 404);
    const plan = await call(path + '/plan', { method: 'POST', headers: { cookie: first },
      body: JSON.stringify({ consent: true, instruction: 'Hide the stop sign, keep the orange cone' }) });
    assert.equal(plan.status, 202);
    const analysis = path + '/analysis/' + (await plan.json()).id;
    assert.equal((await call(analysis, { headers: { cookie: second } })).status, 404);
    let result;
    for (let attempt = 0; attempt < 30; attempt++) {
      result = await (await call(analysis, { headers: { cookie: first } })).json();
      if (result.status === 'complete') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.deepEqual(result, { status: 'complete', result: { hide: 'stop sign', preserve: 'orange cone' } });
    assert.equal((await call(path, { method: 'DELETE', headers: { cookie: first } })).status, 204);
  } finally {
    globalThis.fetch = nativeFetch;
    await new Promise(resolve => server.close(resolve));
  }
});
