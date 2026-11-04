const el = id => document.getElementById(id);
const canvas = el('canvas');
const context = canvas.getContext('2d', { alpha: false });
const stateNames = { gap: 'Missing cover', uncertain: 'Uncertain match', suggested: 'Suggested cover', manual: 'Corrected cover', clear: 'Marked clear' };
let clip;
let current = 0;
let busy = false;
let playing = false;
let playbackRun = 0;
let drawing = false;
let original = false;
let drag;
let previewRequest = 0;
let images = new Map();

function notice(text, error = false) {
  el('notice').hidden = !text;
  el('notice').classList.toggle('error', error);
  el('notice').textContent = text;
}

async function call(path, { method = 'GET', data, upload } = {}) {
  const response = await fetch(path, {
    method,
    headers: upload ? { 'Content-Type': 'application/octet-stream' }
      : data ? { 'Content-Type': 'application/json' } : undefined,
    body: upload || (data ? JSON.stringify(data) : undefined),
  });
  if (!response.ok) throw new Error((await response.json()).error || 'The request failed.');
  return response;
}

const pathFor = action => `/api/jobs/${clip.id}${action ? '/' + action : ''}`;
const unresolved = frame => frame.state === 'gap' || frame.state === 'uncertain';

function update() {
  el('choose').disabled = busy;
  el('upload').disabled = busy;
  el('workspace').hidden = !clip;
  el('welcome').hidden = !!clip;
  if (!clip) return;
  const frame = clip.frames[current];
  const gaps = clip.frames.filter(unresolved).length;
  el('source').textContent = `UPLOADED CLIP / ${clip.name} / ${clip.count} FRAMES`;
  el('scrub').max = clip.count - 1;
  el('scrub').value = current;
  el('through').min = current + 1;
  el('through').max = clip.count;
  el('time').textContent = `${(current / clip.fps).toFixed(2)} s`;
  el('frame-state').textContent = `FRAME ${current + 1} / ${stateNames[frame.state]}`;
  el('frame-state').classList.toggle('review', unresolved(frame));
  el('review-copy').textContent = gaps ? `${gaps} frame${gaps === 1 ? '' : 's'} need a review decision.` : 'All frames have a decision. Play the clip to verify the cover and evidence.';
  el('preserve-hint').textContent = el('preserve').value.trim() ? 'Keep visible: ' + el('preserve').value.trim() : '';
  el('live-status').textContent = clip.live ? 'KEY CONFIGURED' : 'MANUAL MODE';
  el('plan').disabled = busy || !clip.live || !el('consent').checked;
  el('track').disabled = busy || !clip.live || !el('consent').checked;
  el('gap').disabled = busy || !gaps;
  el('draw').disabled = busy;
  el('clear').disabled = busy;
  el('remove').disabled = busy;
  el('approve').disabled = busy || gaps > 0;
  el('export').disabled = busy || !!gaps || !el('approve').checked || !clip.frames.some(frame => frame.box);
  el('play').textContent = playing ? 'Pause' : 'Play';
  el('play').setAttribute('aria-pressed', playing);
  el('draw').setAttribute('aria-pressed', drawing);
  el('draw').textContent = drawing ? 'Cancel drawing' : 'Draw cover';
  el('original').textContent = original ? 'Show redacted' : 'Show original';
  el('original').setAttribute('aria-pressed', original);
  canvas.classList.toggle('drawing', drawing);
  if (el('timeline').children.length !== clip.count) {
    el('timeline').replaceChildren(...clip.frames.map(() => document.createElement('i')));
  }
  for (const [index, segment] of [...el('timeline').children].entries()) {
    segment.dataset.state = clip.frames[index].state;
    segment.classList.toggle('active', index === current);
  }
}

function frameImage(index) {
  if (!images.has(index)) {
    const image = new Image();
    const result = new Promise((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Could not load this frame. The clip may have expired.'));
      image.src = pathFor('frame/' + index);
    });
    const cache = images;
    result.catch(() => cache.delete(index));
    images.set(index, result);
    if (images.size > 24) images.delete(images.keys().next().value);
  }
  return images.get(index);
}

function fillBox(box) {
  const [x, y, right, bottom] = box;
  context.fillStyle = '#000';
  context.fillRect(x, y, right - x, bottom - y);
}

function rectangle(start, end) {
  return [Math.floor(Math.min(start[0], end[0])), Math.floor(Math.min(start[1], end[1])),
    Math.ceil(Math.max(start[0], end[0])), Math.ceil(Math.max(start[1], end[1]))];
}

async function paint() {
  if (!clip) return;
  const request = ++previewRequest;
  const index = current;
  try {
    const frame = await frameImage(index);
    if (request !== previewRequest) return;
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    if (!original && !drawing && clip.frames[index].box) fillBox(clip.frames[index].box);
    if (drag) {
      const [x, y, right, bottom] = rectangle(drag.start, drag.end);
      context.strokeStyle = '#b2edca';
      context.lineWidth = 3;
      context.strokeRect(x, y, right - x, bottom - y);
    }
  } catch (error) {
    if (request === previewRequest) {
      playing = false;
      update();
      notice(error.message, true);
    }
  }
}

function seek(index) {
  current = Math.max(0, Math.min(clip.count - 1, index));
  el('through').value = current + 1;
  update();
  return paint();
}

function jump(index) {
  playing = false;
  drawing = false;
  drag = undefined;
  return seek(index);
}

async function task(message, work) {
  if (busy) return;
  busy = true;
  playing = false;
  drawing = false;
  drag = undefined;
  notice(message);
  update();
  try {
    await work();
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    update();
    void paint();
  }
}

el('choose').addEventListener('click', () => el('upload').click());
el('upload').addEventListener('change', event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  void task('Preparing exact review frames…', async () => {
    const previous = clip;
    const result = await call('/api/upload', { method: 'POST', upload: file });
    clip = { ...await result.json(), name: file.name };
    if (previous) void call(`/api/jobs/${previous.id}`, { method: 'DELETE' }).catch(() => {});
    images = new Map();
    canvas.width = clip.width;
    canvas.height = clip.height;
    original = false;
    el('approve').checked = false;
    el('consent').checked = false;
    el('ai').open = clip.live;
    void seek(0);
    el('workspace').scrollIntoView({ block: 'start' });
    notice('Clip ready. Draw covers manually or open Live Meta analysis.');
  });
});

el('remove').addEventListener('click', () => void task('Deleting the clip…', async () => {
  await call(pathFor(), { method: 'DELETE' });
  clip = undefined;
  images.clear();
  previewRequest++;
  context.clearRect(0, 0, canvas.width, canvas.height);
  notice('Clip deleted.');
}));

el('scrub').addEventListener('input', () => void jump(Number(el('scrub').value)));
el('prev').addEventListener('click', () => void jump(current - 1));
el('next').addEventListener('click', () => void jump(current + 1));
el('timeline').addEventListener('click', event => {
  const index = [...el('timeline').children].indexOf(event.target);
  if (index >= 0) void jump(index);
});
el('gap').addEventListener('click', () => {
  const index = clip.frames.findIndex((frame, index) => index > current && unresolved(frame));
  void jump(index >= 0 ? index : clip.frames.findIndex(unresolved));
});
el('play').addEventListener('click', async () => {
  playing = !playing;
  drawing = false;
  drag = undefined;
  update();
  const run = ++playbackRun;
  if (!playing) return;
  if (current === clip.count - 1) await seek(0);
  while (playing && run === playbackRun && current < clip.count - 1) {
    const started = performance.now();
    await seek(current + 1);
    const wait = Math.max(0, 1000 / clip.fps - (performance.now() - started));
    await new Promise(resolve => setTimeout(resolve, wait));
  }
  if (run === playbackRun) {
    playing = false;
    update();
  }
});
el('original').addEventListener('click', () => {
  original = !original;
  update();
  void paint();
});
el('draw').addEventListener('click', () => {
  playing = false;
  drawing = !drawing;
  drag = undefined;
  original = false;
  update();
  void paint();
});

function apply(box) {
  const final = Number(el('through').value);
  if (!Number.isInteger(final) || final < current + 1 || final > clip.count) {
    notice('Enter a valid final frame for the edit.', true);
    return false;
  }
  const state = box ? 'manual' : 'clear';
  clip.frames.fill({ box, state }, current, final);
  el('approve').checked = false;
  notice(`${box ? 'Cover applied' : 'Marked clear'} on ${final - current} frame${final - current === 1 ? '' : 's'}.`);
  return true;
}

el('clear').addEventListener('click', () => {
  playing = false;
  drawing = false;
  drag = undefined;
  apply(null);
  update();
  void paint();
});

function point(event) {
  const bounds = canvas.getBoundingClientRect();
  return [
    Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width)),
    Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height)),
  ];
}

canvas.addEventListener('pointerdown', event => {
  if (!drawing || !event.isPrimary || event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId);
  const start = point(event);
  drag = { start, end: start };
});
canvas.addEventListener('pointermove', event => {
  if (!drag || !event.isPrimary) return;
  drag.end = point(event);
  void paint();
});
canvas.addEventListener('pointerup', event => {
  if (!drag || !event.isPrimary) return;
  const box = rectangle(drag.start, point(event));
  drag = undefined;
  if (box[2] - box[0] >= 3 && box[3] - box[1] >= 3 && apply(box)) drawing = false;
  update();
  void paint();
});
canvas.addEventListener('pointercancel', () => { drag = undefined; void paint(); });

for (const id of ['consent', 'approve', 'preserve']) el(id).addEventListener('input', update);

el('plan').addEventListener('click', () => void task('Muse Spark is reading sampled frames…', async () => {
  const response = await call(pathFor('plan'), { method: 'POST',
    data: { consent: el('consent').checked, instruction: el('instruction').value } });
  const plan = await response.json();
  el('hide').value = plan.hide;
  el('preserve').value = plan.preserve;
  notice('Targets suggested. Check the wording before tracking.');
}));
el('track').addEventListener('click', () => {
  if (clip.frames.some(frame => ['manual', 'clear'].includes(frame.state))
      && !window.confirm('Replace your existing edits with a fresh track?')) return;
  void task('SAM 3.1 is tracking the selected target…', async () => {
    const response = await call(pathFor('track'), { method: 'POST',
      data: { consent: el('consent').checked, target: el('hide').value } });
    clip.frames = (await response.json()).frames;
    el('approve').checked = false;
    notice(clip.frames.some(frame => frame.box)
      ? 'Tracking complete. Review uncertain frames and confirm the clip.'
      : 'No matching covers. Try a more specific target or draw covers manually.');
  });
});
el('export').addEventListener('click', () => void task('Rendering a silent MP4 with the approved covers…', async () => {
  const response = await call(pathFor('export'), { method: 'POST',
    data: { approved: el('approve').checked, frames: clip.frames } });
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'sharesafe-redacted.mp4';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  notice('Redacted MP4 downloaded.');
}));

call('/api/status').then(response => response.json()).then(({ live }) => {
  el('system').textContent = live ? 'META API CONFIGURED' : 'MANUAL MODE AVAILABLE';
}).catch(() => {});
