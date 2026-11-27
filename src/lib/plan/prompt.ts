import { getWorkersAi } from "@/lib/cloudflare/env";
import type { TodoistMetadata, TodoistProjectSummary } from "@/lib/todoist/mcp-parser";
import { extractPlanPayload } from "./ai-response";
import type { NormalizedTask } from "./contract";
import type { PlanScenario } from "./intent";
import { normalizeTask } from "./normalize";
import {
  PLAN_JSON_SCHEMA,
  PLAN_MODEL_ID,
  aiPlanSchema,
  type IntentDecision,
  type PlanRequestInput,
} from "./schemas";

export function inferProjectFromPrompt(
  prompt: string,
  context: TodoistMetadata,
): TodoistProjectSummary | null {
  if (!context.projects.length) {
    return null;
  }
  const normalizedPrompt = prompt.toLowerCase();
  return (
    context.projects.find(
      (project) => normalizedPrompt.includes(project.name.toLowerCase()) && !project.isInbox,
    ) ?? null
  );
}

export function inferLabelsFromPrompt(
  prompt: string,
  context: TodoistMetadata,
): string[] | undefined {
  if (!context.labels.length) {
    return undefined;
  }
  const normalizedPrompt = prompt.toLowerCase();
  const matches = context.labels
    .filter((label) => normalizedPrompt.includes(label.name.toLowerCase()))
    .map((label) => label.name);
  return matches.length ? matches : undefined;
}

export function buildPlanPrompt(
  input: PlanRequestInput,
  scenario: PlanScenario,
  decision: IntentDecision,
  context: TodoistMetadata,
  priorityHint?: number,
  inferredProject?: TodoistProjectSummary | null,
  inferredLabels?: string[],
): string {
  const limits = `Plan no more than ${scenario.maxTasks} actionable task${scenario.maxTasks === 1 ? "" : "s"}.`;
  const due = input.due ? `Target deadline: ${input.due}.` : "";
  const tz = input.timezone ? `User timezone: ${input.timezone}.` : "";
  const priority = input.priority
    ? `Use Todoist priority ${input.priority} as default unless the plan specifies otherwise.`
    : "";
  const labels = input.labels?.length ? `Preferred labels: ${input.labels.join(", ")}.` : "";
  const keywords = decision.keywords?.length
    ? `Key entities to respect: ${decision.keywords.join(", ")}.`
    : "";
  const intentSummary = decision.summary ? `Intent reasoning: ${decision.summary}` : "";
  const scenarioGuidance = scenario.directives.join(" ");

  const projectContext =
    context.projects.length > 0
      ? `Available Todoist projects (use their IDs when the user references them): ${context.projects
          .slice(0, 12)
          .map((project) => `"${project.name}" (id: ${project.id}${project.isInbox ? ", inbox" : ""})`)
          .join("; ")}.`
      : "Project metadata is unavailable; leave projectId undefined unless the user explicitly specifies one.";

  const defaultProjectContext = inferredProject
    ? `The user wording implies project "${inferredProject.name}". Use this project unless they clearly request another.`
    : "";

  const labelContext =
    context.labels.length > 0
      ? `Available Todoist labels: ${context.labels
          .slice(0, 15)
          .map((label) => `"${label.name}"`)
          .join(", ")}. Only use labels from this list when the user asks for them.`
      : "Label metadata is unavailable; only assign labels when the user clearly asks for them.";

  const defaultLabelsContext = inferredLabels?.length
    ? `The user intent suggests these labels: ${inferredLabels.join(", ")}. Apply them where relevant.`
    : "";

  const priorityHintText = priorityHint
    ? `User hinted priority should default to Todoist priority ${priorityHint}.`
    : "";

  const systemContent = [
    "You are a task planner that produces structured Todoist tasks.",
    "Return structured data that maps to the Todoist add-task payload.",
    "Every task must include a concise title and optional metadata.",
    "If no due overrides are present, prefer natural language due strings that respect the supplied timezone.",
    "Task titles must only describe the action (for example, 'Buy groceries'); express times, dates, and locations exclusively through the due fields or description, never inside the title itself.",
    `Detected scenario: ${scenario.intent}.`,
    intentSummary,
    scenarioGuidance,
    projectContext,
    defaultProjectContext,
    labelContext,
    defaultLabelsContext,
    keywords,
    'Interpret priority cues such as P0/P1/P2/P3 (Todoist UI labels) or phrases like "high priority" and convert them to Todoist API numbers where 4 = P1 (highest) and 1 = P4 (lowest). Treat P0 and P1 as the highest priority, map P2 to 3, P3 to 2, and default to 1 when hints are missing.',
    "Respond with JSON that EXACTLY matches this shape (do not wrap it in markdown fences):",
    "{",
    '  "summary"?: "One paragraph summary of the schedule",',
    '  "tasks": [ { "title": string, "description"?: string, "priority"?: number 1-4, "projectId"?: string, "project"?: string, "labels"?: string[], "due"?: { "string"?: string, "date"?: "YYYY-MM-DD", "datetime"?: ISO8601 } } ]',
    "}",
  ].join(" ");

  const userContent = [
    `User request: ${input.prompt.trim()}`,
    due,
    tz,
    limits,
    priority,
    labels,
    input.preferences ? `Additional preferences: ${input.preferences}` : "",
    priorityHintText,
    "Always keep the plan feasible for the schedule described by the user. When assigning projects, only use the provided project list. When assigning labels, only use names from the provided label list.",
    "Do NOT include markdown code fences around the JSON. Output only the JSON object.",
  ]
    .filter(Boolean)
    .join(" \n");

  return `${systemContent}\n\n${userContent}`;
}

export async function generatePlan(
  env: CloudflareEnv,
  input: PlanRequestInput,
  scenario: PlanScenario,
  decision: IntentDecision,
  context: TodoistMetadata,
  priorityHint?: number,
  inferredProject?: TodoistProjectSummary | null,
  inferredLabels?: string[],
): Promise<{ summary?: string; tasks: NormalizedTask[] }> {
  const ai = getWorkersAi(env);
  const response = await ai.run(PLAN_MODEL_ID, {
    input: buildPlanPrompt(
      input,
      scenario,
      decision,
      context,
      priorityHint,
      inferredProject,
      inferredLabels,
    ),
    response_format: {
      type: "json_schema",
      json_schema: PLAN_JSON_SCHEMA,
    },
    temperature: scenario.temperature,
    max_output_tokens: 2048,
    reasoning: {
      effort: "medium",
      summary: "auto",
    },
  });

  const rawPlan = extractPlanPayload(response);
  const plan = aiPlanSchema.parse(rawPlan);
  const normalized = plan.tasks
    .slice(0, scenario.maxTasks)
    .map((task) =>
      normalizeTask(task, input, context, priorityHint, inferredProject, inferredLabels),
    );

  if (!normalized.length) {
    throw new Error("Model returned no tasks");
  }

  return {
    summary: plan.summary,
    tasks: normalized,
  };
}
