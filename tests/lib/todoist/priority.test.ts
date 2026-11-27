import { describe, expect, it } from "vitest";
import {
  apiPriorityToUiLevel,
  clampPriority,
  dedupeLabels,
  detectPriorityFromPrompt,
  mapApiPriorityToUiFlag,
  mapPriorityCueToApi,
  priorityToUiLabel,
} from "@/lib/todoist/priority";

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

  it("does not match P-shorthand attached to letters or digits", () => {
    expect(detectPriorityFromPrompt("step1 first")).toBeUndefined();
    expect(detectPriorityFromPrompt("loop2 task")).toBeUndefined();
  });

  it("matches 'priority N' and localized '优先级N' cues", () => {
    expect(detectPriorityFromPrompt("priority 2 cleanup")).toBe(3);
    expect(detectPriorityFromPrompt("优先级3 清理日程")).toBe(2);
  });

  it("returns undefined when no valid cue is present", () => {
    expect(detectPriorityFromPrompt("plan a calm evening")).toBeUndefined();
    expect(detectPriorityFromPrompt("")).toBeUndefined();
    expect(detectPriorityFromPrompt("P5 unknown")).toBeUndefined();
  });
});

describe("clampPriority", () => {
  it("returns undefined for undefined input", () => {
    expect(clampPriority(undefined)).toBeUndefined();
  });

  it("clamps values into [1, 4] and rounds non-integers", () => {
    expect(clampPriority(0)).toBe(1);
    expect(clampPriority(-5)).toBe(1);
    expect(clampPriority(1)).toBe(1);
    expect(clampPriority(4)).toBe(4);
    expect(clampPriority(5)).toBe(4);
    expect(clampPriority(2.4)).toBe(2);
    expect(clampPriority(2.6)).toBe(3);
  });
});

describe("dedupeLabels", () => {
  it("returns undefined when input is missing, empty, or blank", () => {
    expect(dedupeLabels()).toBeUndefined();
    expect(dedupeLabels([])).toBeUndefined();
    expect(dedupeLabels(["", "  ", " "])).toBeUndefined();
  });

  it("trims whitespace and deduplicates case-insensitively", () => {
    expect(dedupeLabels(["  ", "", " home ", "office"])).toEqual(["home", "office"]);
    expect(dedupeLabels(["Home", "home", "HOME"])).toEqual(["Home"]);
  });

  it("caps output at five labels", () => {
    expect(dedupeLabels(["a", "b", "c", "d", "e", "f", "g"])).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("priority inversion helpers", () => {
  it("inverts API priority into UI level, badge, and MCP flag", () => {
    expect(apiPriorityToUiLevel(4)).toBe(1);
    expect(apiPriorityToUiLevel(3)).toBe(2);
    expect(apiPriorityToUiLevel(2)).toBe(3);
    expect(apiPriorityToUiLevel(1)).toBe(4);

    expect(priorityToUiLabel(4)).toEqual({ label: "P1", level: 1 });
    expect(priorityToUiLabel(1)).toEqual({ label: "P4", level: 4 });
    expect(priorityToUiLabel(undefined)).toBeUndefined();

    expect(mapApiPriorityToUiFlag(4)).toBe("p1");
    expect(mapApiPriorityToUiFlag(2)).toBe("p3");
    expect(mapApiPriorityToUiFlag(99)).toBe("p1");
  });
});
