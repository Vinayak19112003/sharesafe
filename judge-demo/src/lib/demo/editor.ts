import {
  FRAME_COUNT,
  GAP_FRAMES,
  REQUIRED_FRAMES,
  damageRect,
  intersectArea,
  labelFullyOccluded,
  labelRect,
  type Rect,
} from "./scene";

/**
 * Illustrative tracking data — a prepared example authored in code for this
 * sample, not output from any model run on this clip. Frames in GAP_FRAMES are
 * deliberately missing (the challenge), and fully occluded frames have no box.
 */
const PAD = 4;
const pad = (r: Rect): Rect => ({ x: r.x - PAD, y: r.y - PAD, w: r.w + PAD * 2, h: r.h + PAD * 2 });
export const PREPARED_TRACKING: Record<number, Rect> = Object.fromEntries(
  Array.from({ length: FRAME_COUNT }, (_, f) => f)
    .filter((f) => !GAP_FRAMES.includes(f) && !labelFullyOccluded(f))
    .map((f) => [f, pad(labelRect(f))]),
);

export type CoverSource = "tracked" | "suggested" | "drawn";
export type Cover = { id: string; frame: number; rect: Rect; source: CoverSource };
export type EditorState = { covers: Cover[]; approved: boolean; seq: number };

export function initialState(): EditorState {
  return {
    covers: Object.entries(PREPARED_TRACKING).map(([f, rect]) => ({
      id: `t${f}`,
      frame: Number(f),
      rect,
      source: "tracked" as const,
    })),
    approved: false,
    seq: 0,
  };
}

/** Interpolates the neighbouring prepared boxes; returns null if none on one side. */
export function suggestCover(frame: number): Rect | null {
  const keys = Object.keys(PREPARED_TRACKING).map(Number);
  const prev = Math.max(...keys.filter((k) => k < frame));
  const next = Math.min(...keys.filter((k) => k > frame));
  if (!isFinite(prev) || !isFinite(next)) return null;
  const a = PREPARED_TRACKING[prev];
  const b = PREPARED_TRACKING[next];
  if (!a || !b) return null;
  const t = (frame - prev) / (next - prev);
  const lerp = (x: number, y: number) => Math.round(x + (y - x) * t);
  // grow by 2px to absorb interpolation rounding
  return { x: lerp(a.x, b.x) - 2, y: lerp(a.y, b.y) - 2, w: lerp(a.w, b.w) + 4, h: lerp(a.h, b.h) + 4 };
}

export type Action =
  | { type: "applySuggested"; frame: number }
  | { type: "addDrawn"; frame: number; rect: Rect }
  | { type: "adjust"; id: string; dx: number; dy: number; dw: number; dh: number }
  | { type: "delete"; id: string }
  | { type: "setApproved"; value: boolean }
  | { type: "reset" };

export function reducer(s: EditorState, a: Action): EditorState {
  switch (a.type) {
    case "applySuggested": {
      const rect = suggestCover(a.frame);
      if (!rect) return s;
      return {
        covers: [...s.covers, { id: `s${s.seq}`, frame: a.frame, rect, source: "suggested" }],
        approved: false,
        seq: s.seq + 1,
      };
    }
    case "addDrawn":
      return {
        covers: [...s.covers, { id: `d${s.seq}`, frame: a.frame, rect: a.rect, source: "drawn" }],
        approved: false,
        seq: s.seq + 1,
      };
    case "adjust":
      return {
        ...s,
        approved: false,
        covers: s.covers.map((c) =>
          c.id === a.id && c.source !== "tracked"
            ? {
                ...c,
                rect: {
                  x: c.rect.x + a.dx,
                  y: c.rect.y + a.dy,
                  w: Math.max(4, c.rect.w + a.dw),
                  h: Math.max(4, c.rect.h + a.dh),
                },
              }
            : c,
        ),
      };
    case "delete":
      return { ...s, approved: false, covers: s.covers.filter((c) => c.id !== a.id || c.source === "tracked") };
    case "setApproved":
      return { ...s, approved: a.value };
    case "reset":
      return initialState();
  }
}

export function coversFor(covers: Cover[], frame: number) {
  return covers.filter((c) => c.frame === frame);
}

/** Every integer pixel of the ground-truth label rect lies inside some cover. */
export function frameFullyCovered(covers: Cover[], frame: number) {
  const l = labelRect(frame);
  const rs = coversFor(covers, frame).map((c) => c.rect);
  if (!rs.length) return false;
  for (let y = l.y; y <= l.y + l.h; y++)
    for (let x = l.x; x <= l.x + l.w; x++)
      if (!rs.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) return false;
  return true;
}

export function evaluate(s: EditorState) {
  const uncovered = REQUIRED_FRAMES.filter((f) => !frameFullyCovered(s.covers, f));
  const damageHits = [...new Set(s.covers.filter((c) => intersectArea(c.rect, damageRect(c.frame)) > 0).map((c) => c.frame))].sort((a, b) => a - b);
  const coverageOk = uncovered.length === 0;
  const damageOk = damageHits.length === 0;
  return { uncovered, damageHits, coverageOk, damageOk, canExport: coverageOk && damageOk && s.approved };
}
