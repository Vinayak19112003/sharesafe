import { describe, expect, it } from "vitest";
import { PREPARED_TRACKING, evaluate, frameFullyCovered, initialState, reducer } from "@/lib/demo/editor";
import { FRAME_COUNT, GAP_FRAMES, REQUIRED_FRAMES, damageRect, intersectArea, labelRect, occluderRect } from "@/lib/demo/scene";
import { pickMime, sanitizeFilename } from "@/lib/demo/export";

const fixAll = () => GAP_FRAMES.reduce((s, f) => reducer(s, { type: "applySuggested", frame: f }), initialState());

describe("sample fixture", () => {
  it("covers every required frame except the deliberate gap 26–28", () => {
    expect(evaluate(initialState()).uncovered).toEqual([26, 27, 28]);
  });
  it("only the fully occluded frame 18 is not required", () => {
    expect(REQUIRED_FRAMES.length).toBe(41);
    expect(REQUIRED_FRAMES).not.toContain(18);
  });
  it("label and damage never overlap and tracked boxes avoid damage", () => {
    for (const f of REQUIRED_FRAMES) expect(intersectArea(labelRect(f), damageRect(f))).toBe(0);
    for (const [f, r] of Object.entries(PREPARED_TRACKING)) expect(intersectArea(r, damageRect(+f))).toBe(0);
  });
});

describe("occluder geometry", () => {
  it("the arm never overlaps the damaged corner in any of the 42 frames", () => {
    expect(FRAME_COUNT).toBe(42);
    for (let f = 0; f < FRAME_COUNT; f++) expect(intersectArea(occluderRect(f), damageRect(f))).toBe(0);
  });
  it("keeps 41 required frames and the same 3 gap frames", () => {
    expect(REQUIRED_FRAMES.length).toBe(41);
    expect(GAP_FRAMES).toEqual([26, 27, 28]);
  });
});

describe("edit / export gate", () => {
  it("applying a cover touches only that frame", () => {
    const s = reducer(initialState(), { type: "applySuggested", frame: 27 });
    expect(frameFullyCovered(s.covers, 27)).toBe(true);
    expect(evaluate(s).uncovered).toEqual([26, 28]);
  });
  it("blocks export until coverage is complete and review confirmed", () => {
    expect(evaluate(reducer(initialState(), { type: "setApproved", value: true })).canExport).toBe(false);
    const s = fixAll();
    expect(evaluate(s).coverageOk).toBe(true);
    expect(evaluate(s).canExport).toBe(false);
    expect(evaluate(reducer(s, { type: "setApproved", value: true })).canExport).toBe(true);
  });
  it("any edit clears approval", () => {
    let s = reducer(fixAll(), { type: "setApproved", value: true });
    s = reducer(s, { type: "addDrawn", frame: 3, rect: { x: 0, y: 0, w: 10, h: 10 } });
    expect(s.approved).toBe(false);
  });
  it("a cover over the damaged corner blocks export", () => {
    let s = reducer(fixAll(), { type: "addDrawn", frame: 5, rect: damageRect(5) });
    s = reducer(s, { type: "setApproved", value: true });
    const e = evaluate(s);
    expect(e.damageHits).toEqual([5]);
    expect(e.canExport).toBe(false);
  });
  it("tracked covers cannot be deleted", () => {
    const s = reducer(initialState(), { type: "delete", id: "t0" });
    expect(frameFullyCovered(s.covers, 0)).toBe(true);
  });
});

describe("export helpers", () => {
  it("prefers mp4 then falls back to webm", () => {
    expect(pickMime(() => true)).toMatch(/^video\/mp4/);
    expect(pickMime((t) => t.startsWith("video/webm"))).toBe("video/webm;codecs=vp9");
    expect(pickMime(() => false)).toBeNull();
  });
  it("sanitizes download names", () => {
    expect(sanitizeFilename("../Claim #42/<x>.webm")).toBe("claim-42-x.webm");
    expect(sanitizeFilename("///")).toBe("export");
  });
});
