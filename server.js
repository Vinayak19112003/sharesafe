import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { validBox } from './lib/geometry.js';
import { metaClient } from './lib/meta.js';
import { createLiveDemo } from './lib/live-demo.js';
import { prepareVideo, renderVideo } from './lib/video.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD = 24 * 1024 * 1024;
const TTL = 30 * 60 * 1000;
const apiKey = process.env.META_MODEL_API_KEY || process.env.MODEL_API_KEY || process.env.MUSE_API_KEY;
const meta = apiKey ? metaClient(apiKey) : null;
const guestMode = process.env.SHARESAFE_GUEST_MODE === '1';
const demoPassword = process.env.SHARESAFE_DEMO_PASSWORD;
const digest = value => createHash('sha256').update(value).digest();
const expectedAuth = demoPassword && digest('Basic ' + Buffer.from('judge:' + demoPassword).toString('base64'));
const passwordDigest = demoPassword && digest(demoPassword);
const cookieKey = randomBytes(32);
const cookieName = 'sharesafe_session';
const guestCookie = 'sharesafe_guest';
const sessionSeconds = 8 * 60 * 60;
const signSession = value => createHmac('sha256', cookieKey).update(value).digest('hex');

function sessionId(request, name) {
  const cookie = request.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${name}=(\\d+\\.[a-f0-9]{32})\\.([a-f0-9]{64})(?:;|$)`));
  if (!cookie || Number(cookie[1].split('.')[0]) <= Date.now()) return null;
  return timingSafeEqual(Buffer.from(signSession(name + cookie[1]), 'hex'), Buffer.from(cookie[2], 'hex'))
    ? cookie[1] : null;
}

function signedIn(request) {
  return !expectedAuth || timingSafeEqual(expectedAuth, digest(request.headers.authorization ?? ''))
    || !!sessionId(request, cookieName);
}

function setSession(request, response, name = cookieName) {
  const value = `${Date.now() + sessionSeconds * 1000}.${randomBytes(16).toString('hex')}`;
  const secure = process.env.HOST === '0.0.0.0'
    || request.headers['x-forwarded-proto']?.split(',')[0].trim() === 'https';
  response.writeHead(303, {
    Location: '/',
    'Set-Cookie': `${name}=${value}.${signSession(name + value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}${secure ? '; Secure' : ''}`,
  }).end();
}

async function loginPage(response, rejected = false) {
  const html = await readFile(join(ROOT, 'public', 'login.html'), 'utf8');
  const message = guestMode ? 'Enter a name of 1 to 60 characters.' : 'That password did not match. Try again.';
  const error = rejected ? `<p class="notice error" role="alert">${message}</p>` : '';
  const field = guestMode
    ? '<label for="name">Your name</label><input id="name" name="name" type="text" autocomplete="given-name" maxlength="60" required>'
    : '<label for="password">Demo password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required>';
  response.writeHead(rejected ? (guestMode ? 400 : 401) : 200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html.replace('<!-- LOGIN_ERROR -->', error).replace('<!-- LOGIN_FIELD -->', field)
    .replace('<!-- LOGIN_HINT -->', guestMode ? 'Enter a name to start a guest session.' : 'Use the ShareSafe demo password.')
    .replace('<!-- LOGIN_MODE -->', guestMode ? 'Guest workspace' : 'Private demo'));
}
const jobs = new Map();
let preparing = 0;
const guestsPreparing = new Set();
let guestCalls = [];

function reserveGuestCall(owner) {
  const now = Date.now();
  guestCalls = guestCalls.filter(call => now - call.time < 60 * 60 * 1000);
  if (guestCalls.length >= 16 || guestCalls.filter(call => call.owner === owner).length >= 4) {
    throw new HttpError(429, 'The live AI limit has been reached. You can still draw covers and export manually.');
  }
  guestCalls.push({ owner, time: now });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const liveDemo = createLiveDemo(meta, join(ROOT, 'media', 'live-sample.mp4'),
  (status, message) => new HttpError(status, message));

const staticFiles = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
};

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function sendFile(response, path, type, headers = {}) {
  const { size } = await stat(path);
  response.writeHead(200, { 'Content-Type': type, 'Content-Length': size, ...headers });
  await pipeline(createReadStream(path), response);
}

async function body(request, limit) {
  if (Number(request.headers['content-length']) > limit) {
    throw new HttpError(413, 'This upload is too large.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new HttpError(413, 'This upload is too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  try {
    return JSON.parse(await body(request, 96 * 1024));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid request body.');
  }
}

async function makeJob(request, owner) {
  const previous = owner && [...jobs.values()].find(job => job.owner === owner);
  if (owner && (guestsPreparing.has(owner) || previous?.busy)) throw new HttpError(409, 'Wait for the current clip to finish processing.');
  if (preparing >= 2 || jobs.size + preparing >= 8) throw new HttpError(503, 'The workspace is busy. Delete an old clip and try again.');
  preparing++;
  if (owner) guestsPreparing.add(owner);
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'sharesafe-'));
    const file = join(directory, 'input.mp4');
    await writeFile(file, await body(request, MAX_UPLOAD), { mode: 0o600 });
    let job;
    try {
      job = await prepareVideo(file, directory);
    } catch (error) {
      throw new HttpError(422, error.message);
    }
    await rm(file);
    const { count, width, height, fps } = job;
    const frames = Array.from({ length: count }, () => ({ box: null, state: 'gap' }));
    const id = randomUUID();
    if (previous?.busy) throw new HttpError(409, 'Wait for the current clip to finish processing.');
    if (previous) await removeJob(previous);
    jobs.set(id, { ...job, id, owner, directory, expires: Date.now() + TTL });
    return { id, count, width, height, fps, frames, live: !!meta, background: !!owner };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    preparing--;
    if (owner) guestsPreparing.delete(owner);
  }
}

async function runJob(job, work) {
  if (jobs.get(job.id) !== job) throw new HttpError(404, 'This clip is unavailable. Upload it again.');
  if (job.busy) throw new HttpError(409, 'This clip is already being processed.');
  job.busy = true;
  try {
    return await work();
  } finally {
    job.busy = false;
    job.expires = Date.now() + TTL;
  }
}

async function removeJob(job) {
  jobs.delete(job.id);
  await rm(job.directory, { recursive: true, force: true });
}

function shortText(value, limit) {
  return typeof value === 'string' && value.trim().length >= 2 && value.length <= limit;
}

export function exportBoxes(job, payload) {
  if (payload?.approved !== true || !Array.isArray(payload.frames) || payload.frames.length !== job.count) {
    throw new HttpError(400, 'Review the clip and confirm before exporting.');
  }
  const boxes = payload.frames.map((frame, index) => {
    if (frame?.state === 'clear' && frame.box === null) return null;
    if (['suggested', 'manual'].includes(frame?.state) && validBox(frame.box, job.width, job.height)) return frame.box;
    throw new HttpError(400, `Resolve the review on frame ${index + 1} first.`);
  });
  if (!boxes.some(Boolean)) throw new HttpError(400, 'Add at least one redaction before exporting.');
  return boxes;
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const { method } = request;
    if (['POST', 'DELETE'].includes(method)
        && request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') {
      throw new HttpError(403, 'Open the app directly to make changes.');
    }
    if (method === 'POST' && path === '/login' && (guestMode || passwordDigest)) {
      const form = new URLSearchParams((await body(request, 4096)).toString());
      if (guestMode) {
        const name = form.get('name')?.trim();
        if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) return await loginPage(response, true);
        if (sessionId(request, guestCookie)) return response.writeHead(303, { Location: '/' }).end();
        return setSession(request, response, guestCookie);
      }
      const password = form.get('password') ?? '';
      if (!timingSafeEqual(passwordDigest, digest(password))) return await loginPage(response, true);
      return setSession(request, response);
    }
    if (method === 'GET' && path === '/live-demo') {
      return await sendFile(response, join(ROOT, 'public', 'index.html'), 'text/html; charset=utf-8');
    }
    if (method === 'GET' && path === '/api/live-demo/sample') {
      return json(response, 200, await liveDemo.getSample());
    }
    const sampleFrame = path.match(/^\/api\/live-demo\/frame\/(\d{1,3})$/);
    if (method === 'GET' && sampleFrame) {
      return await sendFile(response, await liveDemo.getFrame(Number(sampleFrame[1])), 'image/jpeg');
    }
    if (method === 'POST' && path === '/api/live-demo/analyze') {
      if (request.headers['sec-fetch-site'] !== 'same-origin') {
        throw new HttpError(403, 'Open the demo directly to run live analysis.');
      }
      if ((await readJson(request))?.consent !== true) {
        throw new HttpError(400, 'Choose to send the fictional sample to Meta first.');
      }
      return json(response, 202, liveDemo.startAnalysis());
    }
    const analysis = path.match(/^\/api\/live-demo\/analysis\/([a-f0-9-]{36})$/);
    if (method === 'GET' && analysis) {
      return json(response, 200, liveDemo.getAnalysis(analysis[1]));
    }
    if (method === 'POST' && path === '/api/live-demo/export') {
      if (request.headers['sec-fetch-site'] !== 'same-origin') {
        throw new HttpError(403, 'Open the demo directly to export.');
      }
      const video = await liveDemo.export(await readJson(request), exportBoxes);
      response.writeHead(200, {
        'Content-Type': 'video/mp4', 'Content-Length': video.length,
        'Content-Disposition': 'attachment; filename="sharesafe-live-demo.mp4"',
      });
      response.end(video);
      return;
    }
    const owner = guestMode ? sessionId(request, guestCookie) : null;
    if (!(guestMode ? owner : signedIn(request)) && !(method === 'GET' && ['/style.css', '/app.js'].includes(path))) {
      if (method === 'GET' && path === '/') return await loginPage(response);
      return json(response, 401, { error: 'Open the ShareSafe sign-in page to continue.' });
    }
    if (method === 'GET' && Object.hasOwn(staticFiles, path)) {
      const [file, type] = staticFiles[path];
      return await sendFile(response, join(ROOT, file), type);
    }
    if (method === 'GET' && path === '/api/status') return json(response, 200, { live: !!meta });
    if (method === 'POST' && path === '/api/upload') {
      return json(response, 201, await makeJob(request, owner));
    }
    const match = path.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(frame\/\d+|analysis\/[a-f0-9-]{36}|plan|track|export))?$/);
    const job = match && jobs.get(match[1]);
    if (!job || job.owner !== owner) throw new HttpError(404, 'This clip is unavailable. Upload it again.');
    job.expires = Date.now() + TTL;
    const action = match[2];
    if (method === 'GET' && action?.startsWith('analysis/')) {
      const run = job.analysis;
      if (run?.id !== action.slice(9)) throw new HttpError(404, 'This analysis is unavailable. Run it again.');
      if (run.status === 'failed') throw new HttpError(502, 'Meta analysis did not complete. Try again in a moment.');
      return json(response, 200, { status: run.status, result: run.result });
    }
    if (method === 'GET' && action?.startsWith('frame/')) {
      const index = Number(action.slice(6));
      if (index >= job.count) throw new HttpError(404, 'Frame not found.');
      return await sendFile(response, job.framePath(index), 'image/jpeg');
    }
    if (method === 'DELETE' && !action) {
      if (job.busy) throw new HttpError(409, 'Wait for the current action before deleting.');
      await removeJob(job);
      response.writeHead(204).end();
      return;
    }
    if (method === 'POST' && (action === 'plan' || action === 'track')) {
      if (!meta) throw new HttpError(503, 'Configure a server-side Meta Model API key to run live analysis.');
      const payload = await readJson(request);
      if (payload?.consent !== true) throw new HttpError(400, 'Confirm that you want to send this footage to Meta.');
      const value = action === 'plan' ? payload.instruction : payload.target;
      if (!shortText(value, action === 'plan' ? 400 : 70)) throw new HttpError(400, 'Enter a short instruction or object name.');
      const analyze = async () => action === 'plan' ? meta.plan(job, value.trim()) : { frames: await meta.track(job, value.trim()) };
      if (owner) {
        if (jobs.get(job.id) !== job) throw new HttpError(404, 'This clip is unavailable. Upload it again.');
        if (job.busy) {
          const run = job.analysis;
          if (run?.status === 'running' && run.action === action && run.value === value.trim()) return json(response, 202, { id: run.id });
          throw new HttpError(409, 'This clip is already being processed.');
        }
        reserveGuestCall(owner);
        const run = { id: randomUUID(), action, value: value.trim(), status: 'running' };
        job.analysis = run;
        void runJob(job, analyze).then(result => {
          run.result = result;
          run.status = 'complete';
        }, () => { run.status = 'failed'; });
        return json(response, 202, { id: run.id });
      }
      return await runJob(job, async () => {
        try {
          return json(response, 200, await analyze());
        } catch (error) {
          throw new HttpError(502, `Live analysis failed. ${error.message}`);
        }
      });
    }
    if (method === 'POST' && action === 'export') {
      const boxes = exportBoxes(job, await readJson(request));
      const video = await runJob(job, async () => {
        const output = join(job.directory, 'export.mp4');
        try {
          await renderVideo(job, boxes, output);
          return await readFile(output);
        } finally {
          await rm(output, { force: true });
        }
      });
      response.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': video.length,
        'Content-Disposition': 'attachment; filename="sharesafe-redacted.mp4"',
      });
      response.end(video);
      return;
    }
    throw new HttpError(405, 'This action is unavailable.');
  } catch (error) {
    if (response.headersSent || response.destroyed) return response.destroy();
    if (error instanceof HttpError) return json(response, error.status, { error: error.message });
    return json(response, 500, { error: 'ShareSafe could not finish this action. Try again.' });
  }
});

export function start(port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1') {
  if (meta && !guestMode && !expectedAuth && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('Set SHARESAFE_DEMO_PASSWORD or explicitly enable SHARESAFE_GUEST_MODE before hosting Meta.');
  }
  server.listen(port, host);
  const cleanup = setInterval(() => {
    for (const job of jobs.values()) {
      if (!job.busy && job.expires < Date.now()) void removeJob(job).catch(() => {});
    }
  }, 60_000).unref();
  server.once('close', () => {
    clearInterval(cleanup);
    void liveDemo.close().catch(() => {});
    for (const job of jobs.values()) void removeJob(job).catch(() => {});
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const listening = start();
  listening.on('listening', () => console.log(`ShareSafe ready on port ${listening.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => listening.close());
}
