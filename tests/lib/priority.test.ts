import { describe, expect, it } from "vitest";
import {
  apiPriorityToUiLevel,
  clampPriority,
  dedupeLabels,
  detectPriorityFromPrompt,
  mapPriorityCueToApi,
  priorityToUiLabel,
} from "@/lib/priority";

describe("mapPriorityCueToApi", () => {
  it("maps P0 and P1 to highest priority (4)", () => {
    expect(mapPriorityCueToApi("0")).toBe(4);
    expect(mapPriorityCueToApi("1")).toBe(4);
  });

  it("maps P2/P3/P4 to 3/2/1 respectively", () => {
    expect(mapPriorityCueToApi("2")).toBe(3);
    expect(mapPriorityCueToApi("3")).toBe(2);
    expect(mapPriorityCueToApi("4")).toBe(1);
  });

  it("returns undefined for unknown signals", () => {
    expect(mapPriorityCueToApi("5")).toBeUndefined();
    expect(mapPriorityCueToApi("")).toBeUndefined();
    expect(mapPriorityCueToApi("p1")).toBeUndefined();
  });
});

describe("detectPriorityFromPrompt", () => {
  it("detects P-shorthand at the start of a prompt", () => {
    expect(detectPriorityFromPrompt("P1 ship the migration")).toBe(4);
    expect(detectPriorityFromPrompt("p2 review docs")).toBe(3);
  });

  it("detects P-shorthand mid-sentence after a non-alphanumeric boundary", () => {
    expect(detectPriorityFromPrompt("Plan a p3 day")).toBe(2);
    expect(detectPriorityFromPrompt("Tomorrow: P4 cleanup")).toBe(1);
  });

  it("does not match P-shorthand glued to letters or digits", () => {
    expect(detectPriorityFromPrompt("step1 first")).toBeUndefined();
    expect(detectPriorityFromPrompt("loop2 task")).toBeUndefined();
  });

  it("matches the 'priority N' phrasing", () => {
    expect(detectPriorityFromPrompt("priority 2 cleanup")).toBe(3);
  });

  it("matches the localized '优先级N' phrasing", () => {
    expect(detectPriorityFromPrompt("优先级3 清理日程")).toBe(2);
  });

  it("returns undefined when no recognizable cue is present", () => {
    expect(detectPriorityFromPrompt("plan a calm evening")).toBeUndefined();
    expect(detectPriorityFromPrompt("")).toBeUndefined();
  });

  it("ignores out-of-range digits attached to P", () => {
    expect(detectPriorityFromPrompt("P5 unknown")).toBeUndefined();
  });
});

describe("clampPriority", () => {
  it("returns undefined for undefined input", () => {
    expect(clampPriority(undefined)).toBeUndefined();
  });

  it("clamps below 1 up to 1 and above 4 down to 4", () => {
    expect(clampPriority(0)).toBe(1);
    expect(clampPriority(-5)).toBe(1);
    expect(clampPriority(1)).toBe(1);
    expect(clampPriority(4)).toBe(4);
    expect(clampPriority(5)).toBe(4);
    expect(clampPriority(99)).toBe(4);
  });

  it("rounds non-integer inputs", () => {
    expect(clampPriority(2.4)).toBe(2);
    expect(clampPriority(2.6)).toBe(3);
  });
});

describe("dedupeLabels", () => {
  it("returns undefined when input is missing or empty", () => {
    expect(dedupeLabels()).toBeUndefined();
    expect(dedupeLabels(undefined)).toBeUndefined();
    expect(dedupeLabels([])).toBeUndefined();
  });

  it("trims whitespace and drops empty strings", () => {
    expect(dedupeLabels(["  ", "", " home ", "office"])).toEqual(["home", "office"]);
  });

  it("deduplicates case-insensitively, keeping the first occurrence", () => {
    expect(dedupeLabels(["Home", "home", "HOME"])).toEqual(["Home"]);
  });

  it("caps the result at five labels", () => {
    expect(dedupeLabels(["a", "b", "c", "d", "e", "f", "g"])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("returns undefined when every entry collapses away", () => {
    expect(dedupeLabels(["", "  ", " "])).toBeUndefined();
  });
});

describe("apiPriorityToUiLevel", () => {
  it("inverts API priority into the visible UI level", () => {
    expect(apiPriorityToUiLevel(4)).toBe(1);
    expect(apiPriorityToUiLevel(3)).toBe(2);
    expect(apiPriorityToUiLevel(2)).toBe(3);
    expect(apiPriorityToUiLevel(1)).toBe(4);
  });

  it("clamps out-of-range input before inverting", () => {
    expect(apiPriorityToUiLevel(0)).toBe(4);
    expect(apiPriorityToUiLevel(9)).toBe(1);
  });
});

describe("priorityToUiLabel", () => {
  it("inverts the REST encoding so API 4 reads as P1 (highest)", () => {
    expect(priorityToUiLabel(4)).toEqual({ label: "P1", level: 1 });
  });

  it("maps API 3/2/1 to P2/P3/P4 respectively", () => {
    expect(priorityToUiLabel(3)).toEqual({ label: "P2", level: 2 });
    expect(priorityToUiLabel(2)).toEqual({ label: "P3", level: 3 });
    expect(priorityToUiLabel(1)).toEqual({ label: "P4", level: 4 });
  });

  it("returns undefined when priority is absent", () => {
    expect(priorityToUiLabel(undefined)).toBeUndefined();
  });

  it("clamps out-of-range input before inverting", () => {
    expect(priorityToUiLabel(0)).toEqual({ label: "P4", level: 4 });
    expect(priorityToUiLabel(9)).toEqual({ label: "P1", level: 1 });
  });
});
