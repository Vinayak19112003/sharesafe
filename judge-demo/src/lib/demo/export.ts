import { FPS, FRAME_COUNT, H, W } from "./scene";

export const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export function pickMime(isSupported: (t: string) => boolean): string | null {
  return MIME_CANDIDATES.find((t) => {
    try {
      return isSupported(t);
    } catch {
      return false;
    }
  }) ?? null;
}

export function describeMime(mime: string) {
  const base = mime.split(";")[0];
  const ext = base === "video/mp4" ? "mp4" : "webm";
  const codec = /codecs=([^;]+)/.exec(mime)?.[1];
  return { ext, label: `${ext.toUpperCase()}${codec ? ` (${codec})` : ""}` };
}

export function sanitizeFilename(name: string) {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-+\./g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return s || "export";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Renders every frame to an offscreen canvas and records it. No audio track. */
export async function exportVideo(
  render: (ctx: CanvasRenderingContext2D, frame: number) => void,
  onProgress: (done: number) => void,
): Promise<{ blob: Blob; mime: string }> {
  if (typeof MediaRecorder === "undefined" || !("captureStream" in HTMLCanvasElement.prototype))
    throw new Error("This browser can't record video from a canvas. Try a recent Chrome, Edge, Firefox or Safari.");
  const mime = pickMime((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) throw new Error("This browser supports no MP4 or WebM recording format.");

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable.");
  render(ctx, 0);
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((res, rej) => {
    rec.onstop = () => res();
    rec.onerror = (e) => rej(new Error(`Recorder error: ${(e as unknown as { error?: Error }).error?.message ?? "unknown"}`));
  });
  try {
    rec.start(250);
    for (let f = 0; f < FRAME_COUNT; f++) {
      render(ctx, f);
      track.requestFrame?.();
      onProgress(f + 1);
      await sleep(1000 / FPS);
    }
    track.requestFrame?.();
    await sleep(1000 / FPS);
    rec.stop();
    await stopped; // final dataavailable fires before stop
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    if (rec.state !== "inactive") rec.stop();
  }
  const type = rec.mimeType || mime;
  const blob = new Blob(chunks, { type: type.split(";")[0] ?? type });
  if (blob.size === 0) throw new Error("Recording produced no data. Please try again.");
  return { blob, mime: type };
}
