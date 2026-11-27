import { z } from "zod";

export const INTENT_MODEL_ID = "@cf/openai/gpt-oss-120b";
export const PLAN_MODEL_ID = "@cf/openai/gpt-oss-20b";
export const MIN_TASKS = 1;
export const MAX_TASKS = 10;
export const DEFAULT_MAX_TASKS = 5;
export const MAX_PLAN_REQUEST_BYTES = 64 * 1024;

export const planRequestSchema = z
  .object({
    input: z
      .object({
        prompt: z.string().min(1, "Prompt is required").max(8192),
        preferences: z.string().min(1).max(2048).optional(),
      })
      .strict(),
    scheduling: z
      .object({
        timezone: z.string().min(3).max(64).optional(),
        due: z.string().min(3).max(256).optional(),
      })
      .strict()
      .optional(),
    defaults: z
      .object({
        priority: z.number().int().min(1).max(4).optional(),
        labels: z.array(z.string().min(1).max(64)).max(5).optional(),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        maxTasks: z.number().int().min(MIN_TASKS).max(MAX_TASKS).default(DEFAULT_MAX_TASKS),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ParsedPlanRequest = z.infer<typeof planRequestSchema>;

export type PlanRequestInput = {
  prompt: string;
  preferences?: string;
  timezone?: string;
  due?: string;
  priority?: number;
  labels?: string[];
  maxTasks: number;
};

export function flattenPlanRequest(parsed: ParsedPlanRequest): PlanRequestInput {
  return {
    prompt: parsed.input.prompt,
    preferences: parsed.input.preferences,
    timezone: parsed.scheduling?.timezone,
    due: parsed.scheduling?.due,
    priority: parsed.defaults?.priority,
    labels: parsed.defaults?.labels,
    maxTasks: parsed.limits?.maxTasks ?? DEFAULT_MAX_TASKS,
  };
}

export const aiPlanSchema = z.object({
  summary: z.string().optional(),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        priority: z.number().int().min(1).max(4).optional(),
        labels: z.array(z.string().min(1)).max(5).optional(),
        projectId: z.string().optional(),
        project: z.string().optional(),
        due: z
          .object({
            string: z.string().optional(),
            date: z
              .string()
              .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
              .optional(),
            datetime: z.iso.datetime().optional(),
          })
          .partial()
          .strict()
          .optional(),
      }),
    )
    .min(MIN_TASKS),
});

export type PlannedTask = z.infer<typeof aiPlanSchema>["tasks"][number];

export const intentDecisionSchema = z.object({
  intent: z.enum(["single_reminder", "multi_step_plan", "recipe_plan", "general_plan"]),
  summary: z.string().optional(),
  days: z.number().int().min(1).max(7).optional(),
  keywords: z.array(z.string().min(1)).max(10).optional(),
});

export type IntentDecision = z.infer<typeof intentDecisionSchema>;

export const PLAN_JSON_SCHEMA = {
  name: "todoist_task_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["tasks"],
    properties: {
      summary: {
        type: "string",
        description: "One paragraph summary of the schedule",
      },
      tasks: {
        type: "array",
        minItems: MIN_TASKS,
        maxItems: MAX_TASKS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: {
              type: "string",
              description: "Task headline ready for Todoist content",
            },
            description: {
              type: "string",
              description: "Optional context for the task",
            },
            priority: {
              type: "integer",
              minimum: 1,
              maximum: 4,
            },
            labels: {
              type: "array",
              maxItems: 5,
              items: {
                type: "string",
              },
            },
            projectId: {
              type: "string",
              description: "Todoist project ID from the provided context",
            },
            project: {
              type: "string",
              description: "Matching Todoist project name from the provided context",
            },
            due: {
              type: "object",
              additionalProperties: false,
              properties: {
                string: {
                  type: "string",
                  description: "Natural language due string",
                },
                date: {
                  type: "string",
                  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
                },
                datetime: {
                  type: "string",
                  format: "date-time",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const INTENT_JSON_SCHEMA = {
  name: "todoist_plan_intent",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["intent"],
    properties: {
      intent: {
        type: "string",
        enum: ["single_reminder", "multi_step_plan", "recipe_plan", "general_plan"],
        description: "Detected scenario for the request.",
      },
      summary: {
        type: "string",
        description: "Short rationale explaining the classification.",
      },
      days: {
        type: "integer",
        minimum: 1,
        maximum: 7,
        description: "Number of days to cover when the plan spans multiple days (optional).",
      },
      keywords: {
        type: "array",
        maxItems: 10,
        items: {
          type: "string",
        },
        description: "Important entities (ingredients, deadlines, etc.) extracted from the request.",
      },
    },
  },
} as const;
