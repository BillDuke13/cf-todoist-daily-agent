import { describe, expect, it } from "vitest";
import { determineScenario } from "@/lib/plan/intent";
import { normalizeTask, selectDue } from "@/lib/plan/normalize";
import { inferLabelsFromPrompt, inferProjectFromPrompt } from "@/lib/plan/prompt";
import { aiPlanSchema, flattenPlanRequest, planRequestSchema } from "@/lib/plan/schemas";
import type { TodoistMetadata } from "@/lib/todoist/mcp-parser";

const metadata: TodoistMetadata = {
  projects: [
    { id: "p-inbox", name: "Inbox", isInbox: true },
    { id: "p-work", name: "Work", isInbox: false },
  ],
  labels: [
    { id: "l-deep", name: "DeepWork" },
    { id: "l-home", name: "Home" },
  ],
};

describe("planRequestSchema & flattenPlanRequest", () => {
  it("applies default maxTasks and rejects unknown keys", () => {
    const parsed = planRequestSchema.parse({ input: { prompt: "Plan today" } });
    expect(flattenPlanRequest(parsed)).toEqual({
      prompt: "Plan today",
      preferences: undefined,
      timezone: undefined,
      due: undefined,
      priority: undefined,
      labels: undefined,
      maxTasks: 5,
    });

    expect(
      planRequestSchema.safeParse({ input: { prompt: "Plan today" }, unknown: true }).success,
    ).toBe(false);
  });

  it("validates ISO datetimes in aiPlanSchema", () => {
    const valid = aiPlanSchema.safeParse({
      tasks: [{ title: "Call dentist", due: { datetime: "2026-11-27T14:00:00Z" } }],
    });
    expect(valid.success).toBe(true);
  });
});

describe("determineScenario", () => {
  const baseInput = { prompt: "Plan", maxTasks: 6 };

  it("forces single_reminder to max 1 task", () => {
    expect(determineScenario({ intent: "single_reminder" }, baseInput).maxTasks).toBe(1);
  });

  it("bounds recipe_plan days to [1, 5] and caps tasks at 10", () => {
    expect(determineScenario({ intent: "recipe_plan", days: 7 }, baseInput).maxTasks).toBe(10);
    expect(determineScenario({ intent: "recipe_plan", days: 2 }, baseInput).maxTasks).toBe(4);
  });

  it("requires at least 2 tasks for multi_step_plan", () => {
    expect(determineScenario({ intent: "multi_step_plan" }, { prompt: "Steps", maxTasks: 1 }).maxTasks).toBe(2);
  });
});

describe("prompt metadata inference & task normalization", () => {
  it("ignores Inbox when inferring project and matches labels case-insensitively", () => {
    expect(inferProjectFromPrompt("Put this in Inbox", metadata)).toBeNull();
    expect(inferProjectFromPrompt("Finish Work tasks", metadata)).toEqual(metadata.projects[1]);
    expect(inferLabelsFromPrompt("Schedule deepwork at home", metadata)).toEqual([
      "DeepWork",
      "Home",
    ]);
  });

  it("selects due fields in datetime > date > string > fallback order", () => {
    expect(
      selectDue({ datetime: "2026-11-27T10:00:00Z", date: "2026-11-27", string: "today" }, "fb"),
    ).toEqual({ datetime: "2026-11-27T10:00:00Z" });
    expect(selectDue({ date: "2026-11-27", string: "today" }, "fb")).toEqual({
      date: "2026-11-27",
    });
    expect(selectDue(undefined, "today 5pm")).toEqual({ string: "today 5pm" });
  });

  it("canonicalizes project, labels, priority, and whitespace", () => {
    const task = normalizeTask(
      {
        title: "  Review PR  ",
        description: "  Check diff  ",
        project: "work",
        labels: ["deepwork", "DEEPWORK", "custom"],
      },
      { prompt: "Review PR", maxTasks: 5, priority: 2, due: "today" },
      metadata,
      4,
    );
    expect(task).toEqual({
      title: "Review PR",
      description: "Check diff",
      priority: 4,
      labels: ["DeepWork", "custom"],
      due: { string: "today" },
      projectId: "p-work",
      projectName: "Work",
    });
  });
});
