import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Cloudflare Worker handler for the `/plan` endpoint.
 * The module orchestrates origin validation, Workers AI intent + planning passes,
 * Todoist MCP metadata discovery, and streaming NDJSON responses.
 * The behavior is documented in `docs/PLAN_PIPELINE.md` and `openapi/plan.yaml`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTENT_MODEL_ID = "@cf/openai/gpt-oss-120b";
const PLAN_MODEL_ID = "@cf/openai/gpt-oss-20b";
const MIN_TASKS = 1;
const MAX_TASKS = 10;

const requestSchema = z.object({
  prompt: z.string().min(1, "Prompt is required"),
  timezone: z.string().min(3).optional(),
  due: z.string().min(3).optional(),
  preferences: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).max(5).optional(),
  priority: z.number().int().min(1).max(4).optional(),
  maxTasks: z.number().int().min(MIN_TASKS).max(MAX_TASKS).default(5),
});

const aiPlanSchema = z.object({
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
            datetime: z.string().datetime().optional(),
          })
          .partial()
          .strict()
          .optional(),
      }),
    )
    .min(MIN_TASKS),
});

type PlanRequestBody = z.infer<typeof requestSchema>;

type PlannedTask = z.infer<typeof aiPlanSchema>["tasks"][number];

const intentDecisionSchema = z.object({
  intent: z.enum(["single_reminder", "multi_step_plan", "recipe_plan", "general_plan"]),
  summary: z.string().optional(),
  days: z.number().int().min(1).max(7).optional(),
  keywords: z.array(z.string().min(1)).max(10).optional(),
});

type IntentDecision = z.infer<typeof intentDecisionSchema>;
type IntentType = IntentDecision["intent"];

type PlanScenario = {
  intent: IntentType;
  maxTasks: number;
  directives: string[];
  temperature: number;
};

type TodoistProjectSummary = {
  id: string;
  name: string;
  isInbox: boolean;
};

type TodoistLabelSummary = {
  id: string;
  name: string;
};

type TodoistMetadata = {
  projects: TodoistProjectSummary[];
  labels: TodoistLabelSummary[];
};


type TodoistListToolAlias = {
  names?: string[];
  match?: (tool: Tool) => boolean;
  buildArgs?: (toolName: string, tool: Tool) => Record<string, unknown> | undefined;
  resultKeys?: string[];
};

type TodoistListToolConfig = {
  name: string;
  args?: Record<string, unknown>;
  resultKeys?: string[];
};

const PROJECT_TOOL_ALIASES: TodoistListToolAlias[] = [
  {
    names: ["todoist_projects"],
    buildArgs: () => ({ action: "list", include_archived: false }),
    resultKeys: ["data", "projects"],
  },
  {
    names: ["todoist.projects.list", "todoist.projects.search", "todoist.projects.overview"],
    resultKeys: ["projects", "items", "data", "results"],
  },
  {
    match: (tool) => tool.name === "find-projects",
    resultKeys: ["projects", "data"],
  },
  {
    match: (tool) => matchesListTool(tool, ["project", "projects"]),
  },
];

const LABEL_TOOL_ALIASES: TodoistListToolAlias[] = [
  {
    names: ["todoist_labels"],
    buildArgs: () => ({ action: "list", limit: 100 }),
    resultKeys: ["data", "labels"],
  },
  {
    names: ["todoist.labels.list", "todoist.labels.search"],
    resultKeys: ["labels", "items", "data", "results"],
  },
  {
    match: (tool) => tool.name === "find-labels",
    resultKeys: ["labels", "data"],
  },
  {
    match: (tool) => matchesListTool(tool, ["label", "labels", "tag", "tags"]),
  },
];

const DEFAULT_COLLECTION_KEYS = ["projects", "labels", "data", "items", "results", "structuredContent"] as const;
const LIST_VERB_KEYWORDS = ["list", "find", "search", "get", "overview", "browse", "view", "all"];
const MUTATING_KEYWORDS = ["add", "create", "update", "delete", "remove", "complete", "close", "assign", "set", "comment"]; 

function matchesListTool(tool: Tool, keywords: string[]) {
  const text = buildToolText(tool);
  if (!keywords.some((keyword) => text.includes(keyword))) {
    return false;
  }
  const hasListVerb = LIST_VERB_KEYWORDS.some((verb) => text.includes(verb));
  if (!hasListVerb) {
    return false;
  }
  if (MUTATING_KEYWORDS.some((verb) => text.includes(verb))) {
    return false;
  }
  return true;
}

function buildToolText(tool: Tool) {
  const description = typeof tool.description === "string" ? tool.description : "";
  return `${tool.name ?? ""} ${description}`.toLowerCase();
}

type NormalizedTask = {
  title: string;
  description?: string;
  priority?: number;
  labels?: string[];
  due?: {
    string?: string;
    date?: string;
    datetime?: string;
  };
  projectId?: string;
  projectName?: string;
};

type TodoistTaskResult = {
  planned: NormalizedTask;
  status: "created" | "failed";
  todoistId?: string;
  error?: string;
};

const planJsonSchema = {
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

const intentJsonSchema = {
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

/**
 * Mirrors the single allowed `FRONTEND_ORIGIN` during CORS preflight checks so browsers
 * can stream `/plan` without guessing headers. Every invalid origin receives a 403 early.
 */
export async function OPTIONS(request: NextRequest) {
  const { env } = getCloudflareContext();
  let origin: string;
  try {
    origin = resolveOrigin(request, env.FRONTEND_ORIGIN);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    throw error;
  }
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(origin, {
      "Access-Control-Max-Age": "600",
    }),
  });
}

/**
 * Streams a newline-delimited JSON response that walks through intent detection,
 * scenario-specific planning, Todoist metadata discovery, and MCP task creation.
 * Each major stage emits progress events so the UI can surface granular status.
 */
export async function POST(request: NextRequest) {
  const { env } = getCloudflareContext();
  let origin: string;
  try {
    origin = resolveOrigin(request, env.FRONTEND_ORIGIN);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    throw error;
  }

  const body = await parseJson(request);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(parsed.error.flatten().formErrors.join("; ") || "Invalid request", origin, 400);
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const { data } = parsed;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      (async () => {
        let transport: StreamableHTTPClientTransport | null = null;
        let client: Client | null = null;
        let availableTools: Tool[] | null = null;
        try {
          transport = createTransport(env);
          client = transport ? new Client({ name: "cf-todoist-daily-agent", version: "0.1.0" }) : null;
          if (client && transport) {
            await client.connect(transport);
            try {
              const toolCatalog = await client.listTools();
              availableTools = toolCatalog?.tools ?? null;
              if (availableTools) {
                console.log("[todoist.tools]", availableTools.map((tool) => tool.name));
                send({
                  type: "debug.tools",
                  tools: availableTools.map((tool) => ({
                    name: tool.name,
                    description: typeof tool.description === "string" ? tool.description : undefined,
                  })),
                  timestamp: new Date().toISOString(),
                });
              }
            } catch (error) {
              console.warn("Unable to list Todoist MCP tools", error);
              send({
                type: "debug.error",
                stage: "tools",
                message: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString(),
              });
            }
          }

          send({
            type: "status",
            stage: "ai:init",
            message: "Planning tasks with Workers AI",
            timestamp: new Date().toISOString(),
          });

          const priorityHint = detectPriorityFromPrompt(data.prompt);
          send({
            type: "status",
            stage: "intent:detect",
            message: "Analyzing the request intent",
            timestamp: new Date().toISOString(),
          });
          const intentDecision = await classifyIntent(env, data);
          const scenario = determineScenario(intentDecision, data);
          send({
            type: "status",
            stage: "intent:classified",
            message: `Detected scenario: ${scenario.intent}`,
            timestamp: new Date().toISOString(),
          });

          const todoistContext = await fetchTodoistMetadata(client, availableTools ?? undefined);
          send({
            type: "debug.metadata",
            projects: todoistContext.projects,
            labels: todoistContext.labels,
            timestamp: new Date().toISOString(),
          });
          const inferredProject = inferProjectFromPrompt(data.prompt, todoistContext);
          const inferredLabels = inferLabelsFromPrompt(data.prompt, todoistContext);
          const plan = await generatePlan(env, data, scenario, intentDecision, todoistContext, priorityHint, inferredProject, inferredLabels);
          console.log("[todoist.debug.plan]", {
            projects: todoistContext.projects,
            inferredProject,
            inferredLabels,
            tasks: plan.tasks,
          });
          send({
            type: "debug.inference",
            inferredProject,
            inferredLabels,
            priorityHint,
            timestamp: new Date().toISOString(),
          });
          send({
            type: "ai.plan",
            summary: plan.summary,
            tasks: plan.tasks,
            intent: scenario.intent,
            timestamp: new Date().toISOString(),
          });

          const todoistResults = client
            ? await syncWithTodoist(client, plan.tasks, env, data, send, availableTools ?? undefined)
            : plan.tasks.map((task) => ({ planned: task, status: "failed" as const, error: "Todoist MCP client is unavailable" }));

          const created = todoistResults.filter((item) => item.status === "created").length;
          const failed = todoistResults.filter((item) => item.status === "failed").length;
          send({
            type: "final",
            created,
            failed,
            elapsedMs: Date.now() - startedAt,
            tasks: todoistResults,
            timestamp: new Date().toISOString(),
          });
          controller.close();
        } catch (error) {
          console.error("/plan failed", error);
          send({
            type: "error",
            message: "Failed to generate the plan",
            detail: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          });
          controller.close();
        } finally {
          await closeClient(client);
        }
      })().catch((error) => {
        console.error("Streaming error", error);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: buildCorsHeaders(origin, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    }),
  });
}

/**
 * Executes the scenario-specific planning pass with Workers AI and normalizes the
 * resulting tasks so downstream Todoist calls always receive bounded arrays.
 */
async function generatePlan(
  env: CloudflareEnv,
  input: PlanRequestBody,
  scenario: PlanScenario,
  decision: IntentDecision,
  context: TodoistMetadata,
  priorityHint?: number,
  inferredProject?: TodoistProjectSummary | null,
  inferredLabels?: string[],
) {
  const ai = env.AI as unknown as {
    run: (model: string, payload: Record<string, unknown>) => Promise<unknown>;
  };

  const response = await ai.run(PLAN_MODEL_ID, {
    input: buildPrompt(input, scenario, decision, context, priorityHint, inferredProject, inferredLabels),
    response_format: {
      type: "json_schema",
      json_schema: planJsonSchema,
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
    .map((task) => normalizeTask(task, input, context, priorityHint, inferredProject, inferredLabels));

  if (!normalized.length) {
    throw new Error("The assistant did not return any tasks");
  }

  return {
    summary: plan.summary,
    tasks: normalized,
  };
}

/**
 * Discovers the latest Todoist projects/labels by inspecting whatever metadata
 * tools the MCP exposes (official or legacy). Missing metadata degrades gracefully.
 */
async function fetchTodoistMetadata(client: Client | null, tools?: Tool[]) {
  if (!client || !tools?.length) {
    return { projects: [], labels: [] };
  }
  const projectTool = resolveListToolConfig(tools, PROJECT_TOOL_ALIASES);
  const labelTool = resolveListToolConfig(tools, LABEL_TOOL_ALIASES);
  if (!projectTool && !labelTool) {
    return { projects: [], labels: [] };
  }
  const [projects, labels] = await Promise.all([
    projectTool ? callTodoistListTool(client, projectTool) : Promise.resolve([]),
    labelTool ? callTodoistListTool(client, labelTool) : Promise.resolve([]),
  ]);
  // Debug: log raw project data to understand the API response structure
  if (Array.isArray(projects) && projects.length > 0) {
    console.log("[todoist.debug.raw-projects]", JSON.stringify(projects.slice(0, 3)));
  }
  const projectSummaries: TodoistProjectSummary[] = Array.isArray(projects)
    ? (projects as Array<{ id: string; name: string; is_inbox_project?: boolean; inbox_project?: boolean; isInbox?: boolean }>).map((project) => ({
        id: project.id,
        name: project.name,
        // Check multiple possible field names for inbox detection
        isInbox: Boolean(project.is_inbox_project || project.inbox_project || project.isInbox) || project.name?.toLowerCase() === "inbox",
      }))
    : [];
  const labelSummaries: TodoistLabelSummary[] = Array.isArray(labels)
    ? (labels as Array<{ id: string; name: string }>).map((label) => ({
        id: label.id,
        name: label.name,
      }))
    : [];
  console.log("[todoist.debug.metadata]", {
    projectTool: projectTool?.name,
    labelTool: labelTool?.name,
    projectSamples: projectSummaries.slice(0, 3),
    labelSamples: labelSummaries.slice(0, 3),
  });
  return { projects: projectSummaries, labels: labelSummaries };
}

/**
 * Invokes the resolved list tool and extracts array payloads regardless of which
 * envelope (`projects`, `items`, `structuredContent`, etc.) the MCP server used.
 */
async function callTodoistListTool(client: Client, config: TodoistListToolConfig) {
  try {
    const response = await client.callTool({
      name: config.name,
      arguments: config.args ?? {},
    });
    return extractArrayPayload(response, config.resultKeys);
  } catch (error) {
    console.warn(`Failed to call ${config.name}`, error);
    return [];
  }
}

function extractArrayPayload(response: unknown, preferredKeys?: string[]) {
  const parsed = parseToolJson<unknown>(response);
  const keys = preferredKeys ?? Array.from(DEFAULT_COLLECTION_KEYS);
  const direct = pluckArray(parsed, keys);
  return Array.isArray(direct) ? direct : [];
}

function pluckArray(value: unknown, keys: string[]): unknown[] | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
    if (candidate && typeof candidate === "object") {
      const nested = pluckArray(candidate, keys);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

/**
 * Attempts to match the available MCP tools against known aliases/keywords so the
 * Worker can adapt whenever Todoist renames their discovery endpoints.
 */
function resolveListToolConfig(tools: Tool[], aliases: TodoistListToolAlias[]): TodoistListToolConfig | null {
  for (const alias of aliases) {
    let matched: Tool | undefined;
    if (alias.names?.length) {
      matched = tools.find((tool) => alias.names!.includes(tool.name));
    }
    if (!matched && alias.match) {
      matched = tools.find(alias.match);
    }
    if (matched) {
      return {
        name: matched.name,
        args: alias.buildArgs?.(matched.name, matched),
        resultKeys: alias.resultKeys,
      };
    }
  }
  return null;
}

/**
 * Scans the natural-language prompt for Todoist-style priority cues such as
 * `P1`, `priority 2`, or localized `优先级3` markers, then maps them to API values.
 */
function detectPriorityFromPrompt(prompt: string) {
  const normalized = prompt.toLowerCase();
  const patterns = [/(?:^|[^a-z0-9])p\s*([0-4])/, /priority\s*([0-4])/, /优先级\s*([0-4])/];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      const priority = mapPriorityCueToApi(match[1]);
      if (priority) {
        return priority;
      }
    }
  }
  return undefined;
}

/**
 * Converts UI-facing `P{n}` shorthand into Todoist REST priorities where 4 is the
 * highest urgency (P1) and 1 is the lowest (P4).
 */
function mapPriorityCueToApi(signal: string) {
  switch (signal) {
    case "0":
    case "1":
      return 4;
    case "2":
      return 3;
    case "3":
      return 2;
    case "4":
      return 1;
    default:
      return undefined;
  }
}

/**
 * Performs a simple keyword match between the prompt and the downloaded project
 * catalog so the planner can suggest a default `projectId` even before AI runs.
 */
function inferProjectFromPrompt(prompt: string, context: TodoistMetadata) {
  if (!context.projects.length) {
    return null;
  }
  const normalizedPrompt = prompt.toLowerCase();
  return context.projects.find((project) => normalizedPrompt.includes(project.name.toLowerCase()) && !project.isInbox) ?? null;
}

/**
 * Mirrors `inferProjectFromPrompt` for labels to provide soft defaults whenever
 * the user explicitly references an existing tag in natural language.
 */
function inferLabelsFromPrompt(prompt: string, context: TodoistMetadata) {
  if (!context.labels.length) {
    return undefined;
  }
  const normalizedPrompt = prompt.toLowerCase();
  const matches = context.labels
    .filter((label) => normalizedPrompt.includes(label.name.toLowerCase()))
    .map((label) => label.name);
  return matches.length ? matches : undefined;
}

/**
 * Runs the lightweight intent classifier so downstream prompts can tailor their
 * directives (for example `single_reminder` vs `multi_step_plan`).
 */
async function classifyIntent(env: CloudflareEnv, input: PlanRequestBody): Promise<IntentDecision> {
  const ai = env.AI as unknown as {
    run: (model: string, payload: Record<string, unknown>) => Promise<unknown>;
  };
  try {
    const response = await ai.run(INTENT_MODEL_ID, {
      input: buildIntentPrompt(input),
      response_format: {
        type: "json_schema",
        json_schema: intentJsonSchema,
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

function determineScenario(decision: IntentDecision, input: PlanRequestBody): PlanScenario {
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
      const maxTasks = clampMax(days * 2);
      return {
        intent: "recipe_plan",
        maxTasks,
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

function buildIntentPrompt(input: PlanRequestBody) {
  const contextLines = [
    input.due ? `Deadline hint: ${input.due}.` : "",
    input.timezone ? `Timezone: ${input.timezone}.` : "",
    input.preferences ? `Preferences: ${input.preferences}.` : "",
    input.labels?.length ? `Labels: ${input.labels.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const examples = [
    'Example A: "Set an alarm for 7 AM tomorrow" → intent: "single_reminder" (one precise action, even if it implies light prep).',
    'Example B: "Write the weekly report in the morning, meet the client in the afternoon, recap at night" → intent: "multi_step_plan" (explicit multiple steps).',
    'Example C: "I have chicken breast and quinoa, plan lunches for the next three days" → intent: "recipe_plan" (ingredients + multi-day meals).',
    'Example D: "Help me design a relaxed weekend schedule" → intent: "general_plan" (open-ended planning).',
  ].join(" ");

  return [
    "You are an intent classifier for a Todoist planning assistant.",
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

function buildPrompt(
  input: PlanRequestBody,
  scenario: PlanScenario,
  decision: IntentDecision,
  context: TodoistMetadata,
  priorityHint?: number,
  inferredProject?: TodoistProjectSummary | null,
  inferredLabels?: string[],
) {
  const limits = `Plan no more than ${scenario.maxTasks} actionable task${scenario.maxTasks === 1 ? "" : "s"}.`;
  const due = input.due ? `Target deadline: ${input.due}.` : "";
  const tz = input.timezone ? `User timezone: ${input.timezone}.` : "";
  const priority = input.priority ? `Use Todoist priority ${input.priority} as default unless the plan specifies otherwise.` : "";
  const labels = input.labels && input.labels.length ? `Preferred labels: ${input.labels.join(", ")}.` : "";
  const keywords = decision.keywords?.length ? `Key entities to respect: ${decision.keywords.join(", ")}.` : "";
  const intentSummary = decision.summary ? `Intent reasoning: ${decision.summary}` : "";
  const scenarioGuidance = scenario.directives.join(" ");

  const projectContext =
    context.projects.length > 0
      ? `Available Todoist projects (use their IDs when the user references them): ${context.projects
          .slice(0, 12)
          .map((project) => `"${project.name}" (id: ${project.id}${project.isInbox ? ", inbox" : ""})`)
          .join("; ")}.`
      : "Project metadata is unavailable; leave projectId undefined unless the user explicitly specifies one.";
  const defaultProjectContext = inferredProject ? `The user wording implies project "${inferredProject.name}". Use this project unless they clearly request another.` : "";
  const labelContext =
    context.labels.length > 0
      ? `Available Todoist labels: ${context.labels
          .slice(0, 15)
          .map((label) => `"${label.name}"`)
          .join(", ")}. Only use labels from this list when the user asks for them.`
      : "Label metadata is unavailable; only assign labels when the user clearly asks for them.";
  const defaultLabelsContext =
    inferredLabels && inferredLabels.length
      ? `The user intent suggests these labels: ${inferredLabels.join(", ")}. Apply them where relevant.`
      : "";
  const priorityHintText = priorityHint ? `User hinted priority should default to Todoist priority ${priorityHint}.` : "";

  const systemContent = [
    "You are a planning assistant that produces Todoist tasks.",
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
    "Interpret priority cues such as P0/P1/P2/P3 (Todoist UI labels) or phrases like “high priority” and convert them to Todoist API numbers where 4 = P1 (highest) and 1 = P4 (lowest). Treat P0 and P1 as the highest priority, map P2 to 3, P3 to 2, and default to 1 when hints are missing.",
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

function normalizeTask(
  task: PlannedTask,
  input: PlanRequestBody,
  context: TodoistMetadata,
  priorityHint?: number,
  inferredProject?: TodoistProjectSummary | null,
  inferredLabels?: string[],
): NormalizedTask {
  const project = resolveProjectReference(task, context, inferredProject);
  return {
    title: task.title.trim(),
    description: task.description?.trim(),
    priority: clampPriority(task.priority ?? priorityHint ?? input.priority),
    labels: normalizeLabels(task.labels, input.labels, context, inferredLabels),
    due: selectDue(task.due, input.due),
    projectId: project?.id,
    projectName: project?.name,
  };
}

function clampPriority(priority?: number) {
  if (priority === undefined) {
    return undefined;
  }
  return Math.min(4, Math.max(1, Math.round(priority)));
}

function mapApiPriorityToUiFlag(priority: number) {
  const normalized = clampPriority(priority) ?? 1;
  const uiLevel = 5 - normalized;
  return `p${uiLevel}`;
}

function normalizeLabels(
  preferred: string[] | undefined,
  fallback: string[] | undefined,
  context: TodoistMetadata,
  inferred?: string[],
) {
  const source = preferred?.length ? preferred : fallback ?? inferred;
  if (!source?.length) {
    return undefined;
  }
  const normalized = source
    .map((label) => {
      const trimmed = label.trim();
      if (!trimmed) {
        return undefined;
      }
      const canonical = context.labels.find((entry) => entry.name.toLowerCase() === trimmed.toLowerCase());
      return canonical?.name ?? trimmed;
    })
    .filter(Boolean) as string[];
  return dedupeLabels(normalized);
}

function resolveProjectReference(task: PlannedTask, context: TodoistMetadata, inferred?: TodoistProjectSummary | null) {
  if (!context.projects.length && !task.projectId && !task.project && !inferred) {
    return undefined;
  }
  if (task.projectId) {
    const known = context.projects.find((project) => project.id === task.projectId);
    return {
      id: task.projectId,
      name: known?.name ?? task.project ?? task.projectId,
    };
  }
  if (task.project) {
    const normalized = task.project.trim();
    const known = context.projects.find((project) => project.name.toLowerCase() === normalized.toLowerCase());
    if (known) {
      return known;
    }
    return { id: undefined, name: normalized };
  }
  return inferred || undefined;
}

function dedupeLabels(labels?: string[]) {
  if (!labels?.length) {
    return undefined;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) {
      continue;
    }
    seen.add(trimmed.toLowerCase());
    result.push(trimmed);
    if (result.length === 5) {
      break;
    }
  }
  return result.length ? result : undefined;
}

function selectDue(fromTask?: PlannedTask["due"], fallback?: string) {
  if (!fromTask && !fallback) {
    return undefined;
  }
  const due: NormalizedTask["due"] = {};
  if (fromTask?.datetime) {
    due.datetime = fromTask.datetime;
    return due;
  }
  if (fromTask?.date) {
    due.date = fromTask.date;
    return due;
  }
  if (fromTask?.string) {
    due.string = fromTask.string;
    return due;
  }
  if (fallback) {
    due.string = fallback;
    return due;
  }
  return undefined;
}

/**
 * Pushes each normalized task to Todoist via the resolved MCP tool and mirrors
 * progress through streamed `todoist.task` events. Supports both single and bulk
 * `add-task(s)` variants and ensures priority + project fields match the schema.
 */
async function syncWithTodoist(
  client: Client,
  tasks: NormalizedTask[],
  env: CloudflareEnv,
  input: PlanRequestBody,
  send: (event: unknown) => void,
  availableTools?: Tool[],
) {
  const todoistUrl = ensureUrl(env.TODOIST_MCP_URL || "");
  const toolName = await resolveToolName(client, todoistUrl, env.TODOIST_TOKEN, availableTools);
  const results: TodoistTaskResult[] = [];

  for (const task of tasks) {
    send({
      type: "todoist.task",
      status: "pending",
      task,
      timestamp: new Date().toISOString(),
    });

    try {
      const isBulkTool = toolName === "add-tasks" || toolName === "add_tasks";
      const args = toTodoistArgs(task, input, { priorityStyle: isBulkTool ? "string" : "number" });
      const payload = isBulkTool ? { tasks: [args] } : args;
      console.log("[todoist.debug.call-args]", { toolName, isBulkTool, payload });
      const response = await client.callTool({
        name: toolName,
        arguments: payload,
      });
      const parsed = parseTodoistResponse(response);
      results.push({
        planned: task,
        status: "created",
        todoistId: parsed?.id,
      });
      send({
        type: "todoist.task",
        status: "created",
        task,
        todoistId: parsed?.id,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ planned: task, status: "failed", error: message });
      send({
        type: "todoist.task",
        status: "failed",
        task,
        error: message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return results;
}

/**
 * Maps internal task fields to the shape expected by Todoist MCP. Some servers use
 * `projectId` while others expect `project_id`, so both are populated defensively.
 */
function toTodoistArgs(task: NormalizedTask, input: PlanRequestBody, options: { priorityStyle: "number" | "string" } = { priorityStyle: "number" }) {
  const payload: Record<string, unknown> = {
    content: task.title,
  };

  if (task.description) {
    payload.description = task.description;
  }
  if (typeof task.priority === "number") {
    payload.priority = options.priorityStyle === "string" ? mapApiPriorityToUiFlag(task.priority) : task.priority;
  }
  if (task.labels) {
    payload.labels = task.labels;
  }
  if (task.projectId) {
    // Try both field names to support different MCP implementations
    payload.projectId = task.projectId;
    payload.project_id = task.projectId;
  }

  const due = task.due;
  if (due?.datetime) {
    payload.dueDatetime = due.datetime;
  } else if (due?.date) {
    payload.dueDate = due.date;
  } else if (due?.string) {
    payload.dueString = due.string;
  } else if (input.due) {
    payload.dueString = input.due;
  }

  return payload;
}

/**
 * Selects the appropriate Todoist creation tool by checking the preferred list first
 * and then falling back to whatever MCP exposed. This keeps the Worker resilient to
 * future tool renames without hard failing on unexpected catalogs.
 */
async function resolveToolName(client: Client, url: URL, token: string, availableTools?: Tool[]) {
  if (!token) {
    throw new Error("TODOIST_TOKEN is required to contact the MCP server");
  }
  let toolsList = availableTools;
  if (!toolsList) {
    const listed = await client.listTools();
    toolsList = listed?.tools ?? [];
  }
  const preferred = ["create_task", "add-task", "add_task", "create-task", "add-tasks", "add_tasks"];
  for (const candidate of preferred) {
    if (toolsList.some((tool: Tool) => tool.name === candidate)) {
      return candidate;
    }
  }
  const available = toolsList.map((tool: Tool) => tool.name).join(", ");
  throw new Error(`No Todoist create task tool found. Available tools: ${available || "none"} @ ${url.toString()}`);
}

function extractToolText(response: unknown) {
  const message = response as {
    content?: Array<{ type?: string; text?: string; mimeType?: string } | unknown>;
  };
  const textBlocks = message.content?.filter((item) => (item as { type?: string }).type === "text") as
    | Array<{ text?: string; mimeType?: string }>
    | undefined;
  if (!textBlocks?.length) {
    return undefined;
  }
  const plainTextBlock = textBlocks.find((block) => block.mimeType !== "application/json" && Boolean(block.text));
  const target = plainTextBlock ?? textBlocks.find((block) => Boolean(block.text));
  return target?.text ? stripJsonFence(target.text) : undefined;
}

function parseToolJson<T>(response: unknown) {
  const structured = extractStructuredContent(response);
  if (structured !== undefined) {
    return structured as T;
  }
  const jsonBlock = extractToolJsonBlock(response);
  if (jsonBlock !== undefined) {
    if (typeof jsonBlock === "string") {
      try {
        return JSON.parse(jsonBlock) as T;
      } catch (error) {
        console.warn("Unable to parse JSON block from MCP response", error);
        return undefined;
      }
    }
    return jsonBlock as T;
  }
  const text = extractToolText(response);
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    console.warn("Unable to parse MCP response payload", error);
    return undefined;
  }
}

function extractToolJsonBlock(response: unknown) {
  const message = response as { content?: Array<{ type?: string; json?: unknown; text?: string; mimeType?: string }> };
  const jsonEntry = message.content?.find((item) => (item as { type?: string }).type === "json") as { json?: unknown } | undefined;
  if (jsonEntry?.json !== undefined) {
    return jsonEntry.json;
  }
  const jsonTextEntry = message.content?.find((item) => (item as { mimeType?: string }).mimeType === "application/json") as { text?: string } | undefined;
  return jsonTextEntry?.text;
}

function extractStructuredContent(response: unknown) {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const payload = response as { structuredContent?: unknown; structured_content?: unknown };
  if (payload.structuredContent !== undefined) {
    return payload.structuredContent;
  }
  return payload.structured_content;
}

function parseTodoistResponse(response: unknown) {
  const parsed = parseToolJson<{ id?: string; task_id?: string; uuid?: string }>(response);
  if (parsed) {
    return { id: parsed.id ?? parsed.task_id ?? parsed.uuid };
  }
  const text = extractToolText(response);
  if (text) {
    return { id: undefined, message: text };
  }
  return undefined;
}

function createTransport(env: CloudflareEnv) {
  if (!env.TODOIST_MCP_URL) {
    console.warn("TODOIST_MCP_URL is not configured. Todoist sync will be skipped.");
    return null;
  }
  const url = ensureUrl(env.TODOIST_MCP_URL);
  const token = env.TODOIST_TOKEN;
  if (!token) {
    console.warn("TODOIST_TOKEN is missing. Todoist sync will be skipped.");
    return null;
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    fetch,
  });
}

function ensureUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    throw new Error("TODOIST_MCP_URL must be a valid URL");
  }
}

async function closeClient(client: Client | null) {
  try {
    await client?.close();
  } catch (error) {
    console.warn("Failed to close MCP client", error);
  }
}

function extractPlanPayload(response: unknown) {
  const payload = extractResponsePayload(response);
  return normalizePlanPayload(payload);
}

function extractResponsePayload(response: unknown) {
  if (!response || typeof response !== "object") {
    throw new Error("Workers AI returned an empty response");
  }
  const result = (response as { choices?: Array<{ message?: { parsed?: unknown; content?: Array<{ text?: string }> } }> }).choices?.[0]?.message;
  if (result?.parsed) {
    return result.parsed;
  }
  if (result?.content?.length) {
    const textChunk = result.content.find((chunk) => chunk?.text);
    if (textChunk?.text) {
      return JSON.parse(textChunk.text);
    }
  }

  const outputs = (response as { output?: Array<{ type?: string; content?: Array<{ text?: string }> }> }).output;
  if (outputs?.length) {
    for (const chunk of outputs) {
      if (chunk.type !== "message" || !chunk.content?.length) {
        continue;
      }
      const textBlock = chunk.content.find((item) => typeof item.text === "string");
      if (textBlock?.text) {
        return JSON.parse(stripJsonFence(textBlock.text));
      }
    }
  }
  return response;
}

function stripJsonFence(payload: string) {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const fenceEnd = trimmed.lastIndexOf("```");
  if (fenceEnd === -1) {
    return trimmed;
  }
  const firstLineBreak = trimmed.indexOf("\n");
  if (firstLineBreak === -1) {
    return trimmed;
  }
  return trimmed.slice(firstLineBreak + 1, fenceEnd).trim();
}

function normalizePlanPayload(value: unknown) {
  if (Array.isArray(value)) {
    return {
      summary: undefined,
      tasks: value,
    };
  }
  return value;
}

async function parseJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function jsonError(message: string, origin: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: buildCorsHeaders(origin, {
      "Content-Type": "application/json",
    }),
  });
}

function resolveOrigin(request: NextRequest, allowed: string) {
  const configured = allowed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!configured.length) {
    throw new Error("FRONTEND_ORIGIN is not configured");
  }
  const requestOrigin = request.headers.get("Origin");
  if (!requestOrigin) {
    return configured[0];
  }
  if (!configured.includes(requestOrigin)) {
    throw new Response("Forbidden", { status: 403 });
  }
  return requestOrigin;
}

function buildCorsHeaders(origin: string, extra?: Record<string, string>) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "OPTIONS, POST",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
    ...extra,
  };
}
