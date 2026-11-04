import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareVideo, renderVideo } from './video.js';

const EXPECTED = { count: 36, width: 640, height: 360, fps: 12 };
const TRACK_TARGET = 'stop sign';
const INSTRUCTION = 'Hide the stop sign, which is a location clue. Keep the orange traffic cone visible as evidence.';
const EVIDENCE = [435, 245, 535, 336];
const CACHE_MS = 60_000;
const HOURLY_LIMIT = 30;

export function targetBox(index) {
  const left = 132 + index;
  return [left, 72, left + 121, 193];
}

export function checkDemoBox(box, index) {
  if (!box) return false;
  const [left, top, right, bottom] = targetBox(index);
  return box[0] <= left && box[1] <= top && box[2] >= right && box[3] >= bottom
    && !(box[0] < EVIDENCE[2] && box[2] > EVIDENCE[0]
      && box[1] < EVIDENCE[3] && box[3] > EVIDENCE[1]);
}

export function createLiveDemo(meta, source, httpError) {
  let prepared;
  let work;
  let result;
  let runs = [];
  let exporting = 0;

  function sample() {
    prepared ??= (async () => {
      const directory = await mkdtemp(join(tmpdir(), 'sharesafe-live-'));
      try {
        const job = await prepareVideo(source, directory);
        if (Object.entries(EXPECTED).some(([key, value]) => job[key] !== value)) {
          throw new Error('The live sample dimensions or frame count changed.');
        }
        return { ...job, directory };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    })().catch(error => {
      prepared = undefined;
      throw error;
    });
    return prepared;
  }

  async function analyze() {
    if (!meta) throw httpError(503, 'Live Meta analysis is unavailable on this server.');
    if (work) return { ...await work, shared: true };
    const now = Date.now();
    runs = runs.filter(time => now - time < 60 * 60 * 1000);
    if (result && (now - Date.parse(result.completedAt) < CACHE_MS || runs.length >= HOURLY_LIMIT)) {
      return { ...result, shared: true };
    }
    if (runs.length >= HOURLY_LIMIT) throw httpError(429, 'The live demo has reached its hourly limit. Try again later.');
    const job = await sample();
    if (work) return { ...await work, shared: true };
    runs.push(now);
    work = (async () => {
      try {
        const [planned, tracked] = await Promise.allSettled([meta.plan(job, INSTRUCTION), meta.track(job, TRACK_TARGET)]);
        if (planned.status !== 'fulfilled' || tracked.status !== 'fulfilled') throw new Error('Meta request failed.');
        const plan = planned.value;
        const tracks = tracked.value;
        const frames = tracks.map((track, index) => ({
          ...track,
          state: !track.box ? 'gap' : checkDemoBox(track.box, index) ? track.state : 'uncertain',
        }));
        result = {
          plan, frames, target: TRACK_TARGET, completedAt: new Date().toISOString(),
          matched: tracks.filter(track => track.box).length,
        };
        return result;
      } catch {
        throw httpError(502, 'Meta analysis did not complete. Try again in a moment.');
      } finally {
        work = undefined;
      }
    })();
    return { ...await work, shared: false };
  }

  return {
    async getSample() {
      const { count, width, height, fps } = await sample();
      return {
        count, width, height, fps, live: !!meta, name: 'Roadside evidence · fictional sample',
        frames: Array.from({ length: count }, () => ({ box: null, state: 'gap' })),
        reference: Array.from({ length: count }, (_, index) => targetBox(index)),
        evidence: EVIDENCE,
      };
    },
    async getFrame(index) {
      const job = await sample();
      if (index >= job.count) throw httpError(404, 'Frame not found.');
      return job.framePath(index);
    },
    analyze,
    async export(payload, exportBoxes) {
      if (!result) throw httpError(409, 'Run live Meta analysis first.');
      const job = await sample();
      const boxes = exportBoxes(job, payload);
      const bad = boxes.findIndex((box, index) => !checkDemoBox(box, index));
      if (bad !== -1) throw httpError(400, `On frame ${bad + 1}, cover the stop sign fully and keep the cone visible.`);
      if (exporting >= 2) throw httpError(503, 'The demo is busy exporting. Try again shortly.');
      exporting++;
      let directory;
      try {
        directory = await mkdtemp(join(tmpdir(), 'sharesafe-live-export-'));
        const output = join(directory, 'sample-redacted.mp4');
        await renderVideo(job, boxes, output);
        return await readFile(output);
      } finally {
        exporting--;
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    },
    async close() {
      if (!prepared) return;
      const job = await prepared.catch(() => null);
      prepared = undefined;
      if (job) await rm(job.directory, { recursive: true, force: true });
    },
  };
}
