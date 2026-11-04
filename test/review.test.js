import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { metaClient, parsePlan, parseSam, readResponseText } from '../lib/meta.js';
import { exportBoxes } from '../server.js';

const shape = { count: 4, width: 100, height: 100 };
const record = (id, confidence = 0.9) => `${id}<|box;x1=20;y1=20;x2=29;y2=29;w=100;h=100;c=${confidence}|><|mask;x=0;y=0;data=10,10,!abc|>`;

function stream(events) {
  const encoder = new TextEncoder();
  const text = events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join('');
  return new Response(new ReadableStream({
    start(controller) {
      const bytes = encoder.encode(text);
      for (let start = 0; start < bytes.length; start += 13) controller.enqueue(bytes.slice(start, start + 13));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const done = { type: 'response.completed' };
const delta = text => ({ type: 'response.output_text.delta', delta: text });

test('Meta event decoder handles split Unicode and requires completion', async () => {
  assert.equal(await readResponseText(stream([delta('Étiquette'), delta(' prête'), done])), 'Étiquette prête');
  await assert.rejects(readResponseText(stream([delta('partial')])), /before completion/);
});

test('SAM uses source frame indices and leaves missed or ambiguous frames unresolved', () => {
  const frames = parseSam(`<2f>${record(4, 0.35)}\n<0f>${record(1)}\n<3f>${record(8)},${record(9)}`, shape);
  assert.deepEqual(frames, [
    { box: [12, 12, 38, 38], state: 'suggested' }, { box: null, state: 'gap' },
    { box: [12, 12, 38, 38], state: 'uncertain' }, { box: null, state: 'gap' },
  ]);
  assert.deepEqual(parseSam(`<0f>${record(1)}<2f>${record(1)}`, shape).map(frame => frame.state),
    ['suggested', 'gap', 'suggested', 'gap']);
  assert.deepEqual(parseSam(`<0f>${record(1).replace('abc', 'abc<99f>abc')}`, shape)[0], frames[0]);
  assert.throws(() => parseSam(`<4f>${record(1)}`, shape), /indices/);
  assert.throws(() => parseSam(`<0f>${record(1).replace('w=100', 'w=99')}`, shape), /dimensions/);
});

test('export requires review, valid boxes, and explicit decisions for missing frames', () => {
  const frames = [{ box: [12, 12, 38, 38], state: 'manual' }, { box: null, state: 'clear' }];
  const job = { ...shape, count: frames.length };
  assert.throws(() => exportBoxes(job, { frames }), /confirm/);
  assert.throws(() => exportBoxes(job, { approved: true, frames: [frames[0], { box: null, state: 'gap' }] }), /frame 2/);
  assert.throws(() => exportBoxes(job, { approved: true, frames: [{ box: [-1, 1, 2, 3], state: 'manual' }, frames[1]] }), /frame 1/);
  assert.deepEqual(exportBoxes(job, { approved: true, frames }), [[12, 12, 38, 38], null]);
});

test('Meta client sends Spark stills and the SAM review clip using documented request parts', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'sharesafe-test-'));
  try {
    const media = join(folder, 'placeholder');
    await writeFile(media, 'sample bytes');
    const requests = [];
    const client = metaClient('fake-key', async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      const value = body.model === 'sam-3.1' ? `<0f>${record(1)}` : '{"hide":"shipping label","preserve":"damaged corner"}';
      return stream([delta(value), done]);
    });
    const job = { ...shape, count: 1, clip: media, framePath: () => media };
    const plan = await client.plan(job, 'Hide the label');
    assert.deepEqual(plan, { hide: 'shipping label', preserve: 'damaged corner' });
    assert.equal((await client.track(job, plan.hide))[0].state, 'suggested');
    assert.equal(requests[0].url, 'https://api.meta.ai/v1/responses');
    assert.match(requests[0].body.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
    assert.match(requests[1].body.input[0].content[1].video_url, /^data:video\/mp4;base64,/);
    assert.equal(requests[1].body.metadata.include_confidence, 'true');
    assert.throws(() => parsePlan('{"hide":"<script>","preserve":"object"}'), /descriptions/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
