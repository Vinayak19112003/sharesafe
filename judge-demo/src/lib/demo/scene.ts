// Deterministic, locally authored sample scene. All geometry lives in one
// source pixel space (W x H); drawing, tracking and coverage share it.
export const W = 640;
export const H = 360;
export const FPS = 12;
export const FRAME_COUNT = 42; // 3.5 s
export const GAP_FRAMES = [26, 27, 28]; // prepared tracking intentionally missing here
export const COVER_COLOR = "#1b1a18";

export type Rect = { x: number; y: number; w: number; h: number };

export function parcelRect(f: number): Rect {
  return {
    x: Math.round(150 + 1.2 * f),
    y: Math.round(84 + Math.sin((f / (FRAME_COUNT - 1)) * Math.PI) * 6),
    w: 300,
    h: 200,
  };
}
export function labelRect(f: number): Rect {
  const p = parcelRect(f);
  return { x: p.x + 24, y: p.y + 28, w: 150, h: 96 };
}
export function damageRect(f: number): Rect {
  const p = parcelRect(f);
  return { x: p.x + 232, y: p.y + 132, w: 68, h: 68 };
}
export function occluderRect(f: number): Rect {
  return { x: Math.round(171 + (f - 18) * 30), y: 40, w: 200, h: 330 };
}

export function contains(outer: Rect, inner: Rect) {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  );
}
export function intersectArea(a: Rect, b: Rect) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
export const labelFullyOccluded = (f: number) => contains(occluderRect(f), labelRect(f));
/** Frames where some part of the label is visible and therefore must be covered. */
export const REQUIRED_FRAMES = Array.from({ length: FRAME_COUNT }, (_, f) => f).filter(
  (f) => !labelFullyOccluded(f),
);

export function drawScene(ctx: CanvasRenderingContext2D, f: number) {
  // table
  ctx.fillStyle = "#3a3430";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#433c37";
  ctx.lineWidth = 2;
  for (let i = 0; i < 9; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 22 + i * 42);
    ctx.lineTo(W, 30 + i * 42);
    ctx.stroke();
  }
  const p = parcelRect(f);
  // shadow + box
  ctx.fillStyle = "#24201d";
  ctx.fillRect(p.x + 10, p.y + 12, p.w, p.h);
  ctx.fillStyle = "#b98b57";
  ctx.fillRect(p.x, p.y, p.w, p.h);
  ctx.fillStyle = "#a57a4a";
  ctx.fillRect(p.x + 196, p.y, 34, p.h); // tape
  ctx.strokeStyle = "#8d6639";
  ctx.lineWidth = 1;
  ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);

  // label
  const l = labelRect(f);
  ctx.fillStyle = "#f4efe4";
  ctx.fillRect(l.x, l.y, l.w, l.h);
  ctx.fillStyle = "#b5432a";
  ctx.fillRect(l.x, l.y, l.w, 16);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 10px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "top";
  ctx.fillText("SAMPLE / DEMO ONLY", l.x + 6, l.y + 3);
  ctx.fillStyle = "#1f1c19";
  ctx.font = "9px ui-monospace, Menlo, monospace";
  const lines = ["SHIP TO: Ada Fictional", "14 Nowhere Lane", "Sampletown ZZ 00000", "TRK 0000-DEMO-4417"];
  lines.forEach((t, i) => ctx.fillText(t, l.x + 6, l.y + 22 + i * 12));
  for (let i = 0; i < 26; i++) {
    ctx.fillRect(l.x + 6 + i * 5, l.y + 74, i % 3 === 0 ? 3 : 1.5, 16); // barcode
  }

  // damaged corner
  const d = damageRect(f);
  ctx.fillStyle = "#7d5a33";
  ctx.beginPath();
  ctx.moveTo(d.x + d.w, d.y);
  ctx.lineTo(d.x + d.w, d.y + d.h);
  ctx.lineTo(d.x, d.y + d.h);
  ctx.lineTo(d.x + 22, d.y + 38);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#2a2016";
  ctx.beginPath();
  ctx.moveTo(d.x + 46, d.y + 40);
  ctx.lineTo(d.x + 64, d.y + 30);
  ctx.lineTo(d.x + 58, d.y + 62);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#5a3f22";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(d.x + 18 + i * 10, d.y + 40 + i * 3);
    ctx.lineTo(d.x + 30 + i * 10, d.y + 66);
    ctx.stroke();
  }

  // moving foreground arm (occluder)
  const o = occluderRect(f);
  if (o.x < W && o.x + o.w > 0) {
    ctx.fillStyle = "#4f5b55";
    ctx.fillRect(o.x, o.y + 60, o.w, o.h - 60);
    ctx.fillStyle = "#c69c7c";
    ctx.fillRect(o.x + 10, o.y, o.w - 20, 70);
    ctx.fillStyle = "#b48a6b";
    for (let i = 0; i < 4; i++) ctx.fillRect(o.x + 18 + i * 42, o.y - 18, 30, 30);
  }
}
