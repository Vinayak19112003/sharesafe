import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const FPS = 12;
const FFMPEG = ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '2'];
const LIMIT = 15;

function launch(program, args) {
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(70_000) });
  const done = once(child, 'close').then(([code]) => {
    if (code !== 0) throw new Error(`${program} could not process this clip.`);
  });
  done.catch(() => {});
  child.stdin.on('error', () => {});
  child.stderr.resume();
  return { child, done };
}

async function command(program, args) {
  const { child, done } = launch(program, args);
  child.stdin.end();
  const parts = [];
  for await (const chunk of child.stdout) parts.push(chunk);
  await done;
  return Buffer.concat(parts).toString();
}

async function probe(file) {
  return JSON.parse(await command('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name:format=format_name,duration',
    '-of', 'json', file]));
}

export async function prepareVideo(file, directory) {
  const input = await probe(file);
  const duration = Number(input.format?.duration);
  if (!input.streams?.length || !input.format?.format_name.split(',').includes('mp4')
      || !Number.isFinite(duration) || duration <= 0 || duration > LIMIT) {
    throw new Error('Choose an MP4 or MOV video between 0 and 15 seconds.');
  }
  const clip = join(directory, 'review.mp4');
  const filter = `fps=${FPS},scale=w='min(720,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`;
  await command('ffmpeg', [...FFMPEG, '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-map_metadata', '-1', '-map_chapters', '-1', '-filter_threads', '1', '-vf', filter,
    '-t', String(LIMIT), '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '19',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip]);
  const { streams: [{ width, height }] } = await probe(clip);
  const framePath = index => join(directory, `frame-${String(index).padStart(4, '0')}.jpg`);
  await command('ffmpeg', [...FFMPEG, '-i', clip, '-map', '0:v:0', '-q:v', '3',
    '-threads', '2', '-start_number', '0', join(directory, 'frame-%04d.jpg')]);
  const count = (await readdir(directory)).filter(name => /^frame-\d+\.jpg$/.test(name)).length;
  if (!count) throw new Error('This video has no reviewable frames.');
  return { clip, count, width, height, fps: FPS, framePath };
}

export async function renderVideo(job, boxes, output) {
  const { width, height, fps } = job;
  const source = launch('ffmpeg', [...FFMPEG, '-i', job.clip, '-map', '0:v:0',
    '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '2', 'pipe:1']);
  const target = launch('ffmpeg', [...FFMPEG, '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0', '-an',
    '-map_metadata', '-1', '-map_chapters', '-1', '-c:v', 'libx264', '-threads', '2',
    '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]);
  source.child.stdin.end();
  target.child.stdout.resume();
  const frame = Buffer.alloc(width * height * 3);
  let used = 0;
  let index = 0;

  try {
    for await (const chunk of source.child.stdout) {
      for (let offset = 0; offset < chunk.length;) {
        const bytes = Math.min(frame.length - used, chunk.length - offset);
        chunk.copy(frame, used, offset, offset + bytes);
        used += bytes;
        offset += bytes;
        if (used !== frame.length) continue;
        if (index >= boxes.length) throw new Error('Render frame count changed.');
        const box = boxes[index++];
        if (box) {
          const [left, top, right, bottom] = box;
          for (let y = top; y < bottom; y++) {
            frame.fill(0, (y * width + left) * 3, (y * width + right) * 3);
          }
        }
        await new Promise((resolve, reject) => target.child.stdin.write(frame, error => error ? reject(error) : resolve()));
        used = 0;
      }
    }
    if (used || index !== boxes.length) throw new Error('Render frame count changed.');
    target.child.stdin.end();
    await Promise.all([source.done, target.done]);
  } catch (error) {
    source.child.kill();
    target.child.kill();
    await Promise.allSettled([source.done, target.done]);
    throw error;
  }
}
