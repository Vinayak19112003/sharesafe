import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  COVER_COLOR,
  FPS,
  FRAME_COUNT,
  GAP_FRAMES,
  H,
  REQUIRED_FRAMES,
  W,
  damageRect,
  drawScene,
  intersectArea,
  type Rect,
} from "@/lib/demo/scene";
import { coversFor, evaluate, frameFullyCovered, initialState, reducer, suggestCover, type Cover } from "@/lib/demo/editor";
import { describeMime, exportVideo, sanitizeFilename } from "@/lib/demo/export";

const RUST = "#c0532f";

function drawCovers(ctx: CanvasRenderingContext2D, covers: Cover[]) {
  ctx.fillStyle = COVER_COLOR;
  for (const c of covers) ctx.fillRect(c.rect.x, c.rect.y, c.rect.w, c.rect.h);
}

type ExportState =
  | { kind: "idle" }
  | { kind: "encoding"; done: number }
  | { kind: "done"; url: string; name: string; label: string; size: number }
  | { kind: "error"; message: string };

const norm = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({
  x: Math.round(Math.min(a.x, b.x)),
  y: Math.round(Math.min(a.y, b.y)),
  w: Math.round(Math.abs(a.x - b.x)),
  h: Math.round(Math.abs(a.y - b.y)),
});

export function DemoEditor() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [redacted, setRedacted] = useState(true);
  const [drawMode, setDrawMode] = useState(false);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState("Sample loaded. Frame 1 ready.");
  const [exp, setExp] = useState<ExportState>({ kind: "idle" });
  const exporting = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const ev = useMemo(() => evaluate(state), [state]);
  const frameCovers = coversFor(state.covers, frame);
  const isGap = GAP_FRAMES.includes(frame);
  const required = REQUIRED_FRAMES.includes(frame);
  const covered = frameFullyCovered(state.covers, frame);
  const suggestion = isGap && !covered ? suggestCover(frame) : null;

  // any edit invalidates a finished export
  const clearExport = useCallback(() => {
    setExp((e) => {
      if (e.kind === "done") URL.revokeObjectURL(e.url);
      return e.kind === "encoding" ? e : { kind: "idle" };
    });
  }, []);
  const edit = (a: Parameters<typeof dispatch>[0], msg: string) => {
    dispatch(a);
    clearExport();
    setStatus(msg + (state.approved ? " Review approval cleared." : ""));
  };

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawScene(ctx, frame);
    if (redacted) drawCovers(ctx, frameCovers);
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    for (const c of frameCovers) {
      ctx.strokeStyle = c.id === selected ? "#f4efe4" : c.source === "tracked" ? "#8fb0a0" : RUST;
      ctx.strokeRect(c.rect.x, c.rect.y, c.rect.w, c.rect.h);
    }
    const d = damageRect(frame);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "#e8c36a";
    ctx.strokeRect(d.x - 3, d.y - 3, d.w + 6, d.h + 6);
    ctx.fillStyle = "#e8c36a";
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.fillText("DAMAGE · KEEP VISIBLE", d.x - 3, d.y + d.h + 8);
    if (suggestion) {
      ctx.strokeStyle = RUST;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(suggestion.x, suggestion.y, suggestion.w, suggestion.h);
      ctx.fillStyle = RUST;
      ctx.fillText("SUGGESTED COVER · NOT APPLIED", suggestion.x, suggestion.y - 12);
    }
    if (draft) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "#f4efe4";
      ctx.strokeRect(draft.x, draft.y, draft.w, draft.h);
    }
    ctx.setLineDash([]);
  }, [frame, frameCovers, redacted, selected, suggestion, draft]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAME_COUNT), 1000 / FPS);
    return () => clearInterval(id);
  }, [playing]);

  const go = (f: number) => {
    setPlaying(false);
    setSelected(null);
    setFrame(Math.max(0, Math.min(FRAME_COUNT - 1, f)));
  };
  const jumpGap = () => {
    const target = GAP_FRAMES.find((f) => !frameFullyCovered(state.covers, f)) ?? ev.uncovered[0] ?? 26;
    go(target);
    setStatus(`Jumped to frame ${target + 1}: label visible, no cover.`);
  };
  const trySample = () => {
    go(0);
    setPlaying(true);
    stageRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    stageRef.current?.focus({ preventScroll: true });
    setStatus("Playing sample. Watch frames 27–29 after the arm passes.");
  };
  const reset = () => {
    dispatch({ type: "reset" });
    clearExport();
    setExp({ kind: "idle" });
    setDrawMode(false);
    setSelected(null);
    setRedacted(true);
    go(0);
    setStatus("Sample reset to the prepared tracking.");
  };

  const toSource = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = toSource(e);
    if (!drawMode) {
      const hit = [...frameCovers].reverse().find((c) => c.source !== "tracked" && p.x >= c.rect.x && p.x <= c.rect.x + c.rect.w && p.y >= c.rect.y && p.y <= c.rect.y + c.rect.h);
      setSelected(hit?.id ?? null);
      return;
    }
    setPlaying(false);
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = p;
    setDraft(norm(p, p));
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (dragStart.current) setDraft(norm(dragStart.current, toSource(e)));
  };
  const onUp = () => {
    const r = draft;
    dragStart.current = null;
    setDraft(null);
    if (!r) return;
    if (r.w < 6 || r.h < 6) return setStatus("Cover too small — drag a larger box.");
    edit({ type: "addDrawn", frame, rect: r }, `Drawn cover added to frame ${frame + 1} only.`);
    setSelected(`d${state.seq}`);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const sel = selected && frameCovers.find((c) => c.id === selected);
    const k = e.key;
    if (sel && k.startsWith("Arrow")) {
      e.preventDefault();
      const s = e.shiftKey;
      const d = { dx: 0, dy: 0, dw: 0, dh: 0 };
      if (k === "ArrowLeft") s ? (d.dw = -2) : (d.dx = -2);
      if (k === "ArrowRight") s ? (d.dw = 2) : (d.dx = 2);
      if (k === "ArrowUp") s ? (d.dh = -2) : (d.dy = -2);
      if (k === "ArrowDown") s ? (d.dh = 2) : (d.dy = 2);
      return edit({ type: "adjust", id: sel.id, ...d }, `Cover adjusted on frame ${frame + 1}.`);
    }
    if (sel && (k === "Delete" || k === "Backspace")) {
      e.preventDefault();
      setSelected(null);
      return edit({ type: "delete", id: sel.id }, `Cover removed from frame ${frame + 1}.`);
    }
    if (k === " ") { e.preventDefault(); setPlaying((p) => !p); }
    else if (k === "ArrowLeft" || k === ",") { e.preventDefault(); go(frame - 1); }
    else if (k === "ArrowRight" || k === ".") { e.preventDefault(); go(frame + 1); }
    else if (k === "g" || k === "G") jumpGap();
  };

  const doExport = async () => {
    if (exporting.current || !ev.canExport) return;
    exporting.current = true;
    setPlaying(false);
    clearExport();
    setExp({ kind: "encoding", done: 0 });
    const snapshot = state.covers;
    try {
      const { blob, mime } = await exportVideo(
        (ctx, f) => { drawScene(ctx, f); drawCovers(ctx, coversFor(snapshot, f)); },
        (done) => setExp({ kind: "encoding", done }),
      );
      const { ext, label } = describeMime(mime);
      const name = sanitizeFilename(`sharesafe-sample-redacted.${ext}`);
      setExp({ kind: "done", url: URL.createObjectURL(blob), name, label, size: blob.size });
      setStatus(`Export ready: ${label}, ${(blob.size / 1024).toFixed(0)} KB.`);
    } catch (err) {
      setExp({ kind: "error", message: err instanceof Error ? err.message : "Export failed." });
    } finally {
      exporting.current = false;
    }
  };

  const busy = exp.kind === "encoding";
  const coveredCount = REQUIRED_FRAMES.length - ev.uncovered.length;

  return (
    <div className="min-h-screen overflow-x-hidden bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <h1 className="font-serif text-lg">ShareSafe — Judge Demo</h1>
          <span className="eyebrow rounded-sm border border-border px-2 py-0.5">Sample only · No uploads</span>
          <div className="ml-auto flex gap-2">
            <button className="btn btn-primary" onClick={trySample}>Try sample</button>
            <button className="btn" onClick={reset} disabled={busy}>Reset sample</button>
          </div>
        </div>
        <ol className="mx-auto grid max-w-6xl gap-2 px-4 pb-3 text-xs text-muted-foreground sm:grid-cols-3">
          <li><span className="font-mono text-primary">1</span> Inspect tracking — play or scrub; green boxes are prepared covers.</li>
          <li><span className="font-mono text-primary">2</span> Fix missed cover — jump to the rust gap and apply or draw a cover.</li>
          <li><span className="font-mono text-primary">3</span> Export — confirm review, then download the redacted clip.</li>
        </ol>
      </header>

      <main className="mx-auto grid max-w-6xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section aria-label="Preview" className="min-w-0 space-y-3">
          <div
            ref={stageRef}
            tabIndex={0}
            onKeyDown={onKey}
            aria-label="Sample preview. Space play or pause, arrows step, G jump to gap."
            className="rounded-md bg-stage p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <canvas
              ref={canvasRef}
              width={W}
              height={H}
              role="img"
              aria-label={`Frame ${frame + 1} of ${FRAME_COUNT}, ${redacted ? "redacted" : "original"} view`}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => { dragStart.current = null; setDraft(null); }}
              className={`block h-auto w-full ${drawMode ? "cursor-crosshair touch-none" : ""}`}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-2 font-mono text-[11px] text-stage-foreground">
              <span>Frame {frame + 1}/{FRAME_COUNT} · {(frame / FPS).toFixed(2)}s · {FPS}fps</span>
              <span>{!required ? "Label fully hidden by arm" : covered ? "Label covered" : "LABEL EXPOSED"}</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button className="btn" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>{playing ? "Pause" : "Play"}</button>
            <button className="btn" onClick={() => go(frame - 1)} aria-label="Previous frame">◀ Step</button>
            <button className="btn" onClick={() => go(frame + 1)} aria-label="Next frame">Step ▶</button>
            <button className="btn" onClick={() => setRedacted((r) => !r)} aria-pressed={!redacted}>{redacted ? "Show original" : "Show redacted"}</button>
            <button className="btn" onClick={jumpGap}>Jump to missing frame</button>
            <button className="btn" onClick={() => { setDrawMode((d) => !d); setSelected(null); }} aria-pressed={drawMode}>{drawMode ? "Drawing… (done)" : "Draw cover"}</button>
          </div>

          <div>
            <label htmlFor="scrub" className="eyebrow">Timeline</label>
            <input id="scrub" type="range" min={0} max={FRAME_COUNT - 1} value={frame} onChange={(e) => go(+e.target.value)} className="w-full accent-primary" aria-valuetext={`Frame ${frame + 1}`} />
            <div className="flex gap-px" aria-hidden>
              {Array.from({ length: FRAME_COUNT }, (_, f) => {
                const missing = ev.uncovered.includes(f);
                const tone = !REQUIRED_FRAMES.includes(f) ? "bg-muted" : missing ? "bg-primary" : "bg-success/70";
                return (
                  <button key={f} tabIndex={-1} onClick={() => go(f)} className={`h-5 min-w-0 flex-1 ${tone} ${f === frame ? "outline-2 outline-foreground" : ""}`} title={`Frame ${f + 1}`} />
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              <span className="text-success">■</span> covered · <span className="text-primary">■</span> missing cover{ev.uncovered.length ? ` (frames ${ev.uncovered.map((f) => f + 1).join(", ")})` : ""} · <span className="text-muted-foreground">■</span> fully occluded
            </p>
          </div>
        </section>

        <aside className="min-w-0 space-y-4 text-sm">
          <section className="rounded-md border border-border bg-card p-3">
            <h2 className="eyebrow mb-2">Frame {frame + 1} covers</h2>
            {suggestion ? (
              <div className="space-y-2">
                <p>Tracking lost the label here. A suggested cover (dashed, interpolated from neighbouring frames) is previewed but not applied.</p>
                <button className="btn btn-primary w-full" onClick={() => edit({ type: "applySuggested", frame }, `Cover applied to frame ${frame + 1} only.`)}>Apply cover to frame {frame + 1}</button>
                {ev.uncovered.filter((f) => GAP_FRAMES.includes(f)).length > 1 && (
                  <button className="btn w-full" onClick={() => {
                    const fs = ev.uncovered.filter((f) => GAP_FRAMES.includes(f));
                    fs.forEach((f) => dispatch({ type: "applySuggested", frame: f }));
                    clearExport();
                    setStatus(`Covers applied to frames ${fs.map((f) => f + 1).join(", ")}.`);
                  }}>Apply to all missing frames ({ev.uncovered.filter((f) => GAP_FRAMES.includes(f)).map((f) => f + 1).join(", ")})</button>
                )}
              </div>
            ) : (
              <ul className="space-y-1">
                {frameCovers.length === 0 && <li className="text-muted-foreground">No covers on this frame.</li>}
                {frameCovers.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <button className="text-left underline-offset-2 hover:underline disabled:no-underline" disabled={c.source === "tracked"} onClick={() => setSelected(c.id)} aria-pressed={selected === c.id}>
                      {c.source === "tracked" ? "Prepared track" : c.source === "suggested" ? "Applied suggestion" : "Drawn cover"}
                      {intersectArea(c.rect, damageRect(frame)) > 0 && <span className="text-destructive"> · overlaps damage</span>}
                    </button>
                    {c.source !== "tracked" && (
                      <button className="btn min-h-7 px-2 text-xs" onClick={() => { setSelected(null); edit({ type: "delete", id: c.id }, `Cover removed from frame ${frame + 1}.`); }}>Remove</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">Edits affect only the current frame. Select a drawn cover, then use arrows to move, Shift+arrows to resize.</p>
          </section>

          <section className="rounded-md border border-border bg-card p-3">
            <h2 className="eyebrow mb-2">Review &amp; export</h2>
            <ul className="space-y-1 text-[13px]">
              <li className={ev.coverageOk ? "text-success" : "text-destructive"}>{ev.coverageOk ? "✓" : "✗"} Label covered on {coveredCount}/{REQUIRED_FRAMES.length} required frames</li>
              <li className={ev.damageOk ? "text-success" : "text-destructive"}>
                {ev.damageOk ? "✓ Damaged corner stays visible" : <>✗ Cover hides damage on frame {ev.damageHits.map((f) => f + 1).join(", ")} — <button className="underline" onClick={() => go(ev.damageHits[0] ?? 0)}>go fix</button></>}
              </li>
            </ul>
            <label className="mt-3 flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 accent-primary" checked={state.approved} disabled={busy} onChange={(e) => { dispatch({ type: "setApproved", value: e.target.checked }); clearExport(); }} />
              <span>I reviewed every frame; the label is hidden and the damage is visible.</span>
            </label>
            <button className="btn btn-primary mt-3 w-full" disabled={!ev.canExport || busy} onClick={doExport}>
              {busy ? `Encoding ${exp.done}/${FRAME_COUNT}…` : "Export redacted video"}
            </button>
            {!ev.canExport && !busy && (
              <p className="mt-1 text-[11px] text-muted-foreground">{!ev.coverageOk ? "Cover the missing frames first." : !ev.damageOk ? "Move covers off the damaged corner." : "Confirm the review to enable export."}</p>
            )}
            {exp.kind === "done" && (
              <div className="mt-3 space-y-1">
                <a className="btn w-full" href={exp.url} download={exp.name}>Download {exp.name}</a>
                <p className="text-[11px] text-muted-foreground">{exp.label} · silent · {(exp.size / 1024).toFixed(0)} KB · {FRAME_COUNT} frames, covers burned in.</p>
              </div>
            )}
            {exp.kind === "error" && <p role="alert" className="mt-2 text-[13px] text-destructive">{exp.message}</p>}
          </section>

          <p role="status" aria-live="polite" className="font-mono text-[11px] text-muted-foreground">{status}</p>
        </aside>
      </main>

      <footer className="mx-auto max-w-6xl border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
        Fictional parcel, drawn in your browser. Illustrative tracking data — a prepared example, not a model run on this clip. Nothing leaves this page. The full ShareSafe Studio adds real uploads, automated tracking and review workflows.
      </footer>
    </div>
  );
}
