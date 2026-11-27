import { getWorkersAi } from "@/lib/cloudflare/env";
import { extractResponsePayload } from "./ai-response";
import type { IntentType } from "./contract";
import {
  INTENT_JSON_SCHEMA,
  INTENT_MODEL_ID,
  MAX_TASKS,
  MIN_TASKS,
  intentDecisionSchema,
  type IntentDecision,
  type PlanRequestInput,
} from "./schemas";

export type PlanScenario = {
  intent: IntentType;
  maxTasks: number;
  directives: string[];
  temperature: number;
};

export function buildIntentPrompt(input: PlanRequestInput): string {
  const contextLines = [
    input.due ? `Deadline hint: ${input.due}.` : "",
    input.timezone ? `Timezone: ${input.timezone}.` : "",
    input.preferences ? `Preferences: ${input.preferences}.` : "",
    input.labels?.length ? `Labels: ${input.labels.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const examples = [
    'Example A: "Set an alarm for 7 AM tomorrow" -> intent: "single_reminder" (one precise action, even if it implies light prep).',
    'Example B: "Write the weekly report in the morning, meet the client in the afternoon, recap at night" -> intent: "multi_step_plan" (explicit multiple steps).',
    'Example C: "I have chicken breast and quinoa, plan lunches for the next three days" -> intent: "recipe_plan" (ingredients + multi-day meals).',
    'Example D: "Help me design a relaxed weekend schedule" -> intent: "general_plan" (open-ended planning).',
  ].join(" ");

  return [
    "You are an intent classifier for a Todoist planning service.",
    "Choose one of: single_reminder, multi_step_plan, recipe_plan, general_plan.",
    "Definitions:",
    "- single_reminder: the user describes exactly one obligation or reminder (often with a time) even if it implies preparation; do NOT expand implicit routines.",
    "- multi_step_plan: the user explicitly requests multiple actions, a schedule, or a breakdown of a period.",
    "- recipe_plan: the user references cooking, meals, menus, or provides ingredient lists to build menus.",
    "- general_plan: any other planning request that does not clearly match the categories above.",
    "Return JSON with fields intent, summary (why this intent fits), optional days (when multiple days are requested), and optional keywords (important entities).",
    examples,
    `User request: ${input.prompt}`,
    contextLines,
  ]
    .filter(Boolean)
    .join(" ");
}

export function determineScenario(decision: IntentDecision, input: PlanRequestInput): PlanScenario {
  const clampMax = (value: number) => Math.min(Math.max(value, MIN_TASKS), MAX_TASKS);

  switch (decision.intent) {
    case "single_reminder":
      return {
        intent: "single_reminder",
        maxTasks: 1,
        directives: [
          "Return exactly one Todoist task that mirrors the reminder wording.",
          "Do not invent extra subtasks or routines; stay literal to the request.",
        ],
        temperature: 0.1,
      };
    case "recipe_plan": {
      const requestedDays = decision.days ?? 3;
      const days = Math.min(Math.max(requestedDays, 1), 5);
      return {
        intent: "recipe_plan",
        maxTasks: clampMax(days * 2),
        directives: [
          `Produce meal-prep tasks covering ${days} day(s). Each task must mention the day and meal (Breakfast/Lunch/Dinner).`,
          "Incorporate the provided ingredients creatively and avoid repeating the same dish twice in a row.",
          "Mention which ingredients are used inside the task description so the cook can verify coverage.",
        ],
        temperature: 0.35,
      };
    }
    case "multi_step_plan":
      return {
        intent: "multi_step_plan",
        maxTasks: clampMax(Math.max(2, input.maxTasks)),
        directives: [
          "Break the day into distinct steps with clear sequencing or time anchors.",
          "Reference dependencies or prerequisites when relevant so the user can follow the workflow.",
        ],
        temperature: 0.25,
      };
    default:
      return {
        intent: "general_plan",
        maxTasks: clampMax(input.maxTasks),
        directives: [
          "Balance the schedule so it feels focused yet achievable.",
          "Only add extra tasks when the request explicitly implies multiple actions.",
        ],
        temperature: 0.2,
      };
  }
}

export async function classifyIntent(
  env: CloudflareEnv,
  input: PlanRequestInput,
): Promise<IntentDecision> {
  const ai = getWorkersAi(env);
  try {
    const response = await ai.run(INTENT_MODEL_ID, {
      input: buildIntentPrompt(input),
      response_format: {
        type: "json_schema",
        json_schema: INTENT_JSON_SCHEMA,
      },
      temperature: 0.1,
      max_output_tokens: 512,
      reasoning: {
        effort: "high",
        summary: "concise",
      },
    });
    const payload = extractResponsePayload(response);
    return intentDecisionSchema.parse(payload);
  } catch (error) {
    console.warn("Failed to classify intent, falling back to general plan", error);
    return {
      intent: "general_plan",
      summary: "Fallback because classification failed",
    };
  }
}
