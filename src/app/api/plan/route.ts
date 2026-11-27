import type { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { isDebugEnabled } from "@/lib/cloudflare/env";
import { buildCorsHeaders } from "@/lib/http/cors";
import { problemResponse, zodIssuesToErrors } from "@/lib/http/errors";
import {
  exceedsDeclaredLength,
  handleCorsPreflight,
  isJsonContentType,
  readJsonBody,
  resolveRequestOrigin,
} from "@/lib/http/request";
import { PLAN_PROTOCOL_VERSION } from "@/lib/plan/contract";
import { classifyIntent, determineScenario } from "@/lib/plan/intent";
import { generatePlan, inferLabelsFromPrompt, inferProjectFromPrompt } from "@/lib/plan/prompt";
import {
  MAX_PLAN_REQUEST_BYTES,
  flattenPlanRequest,
  planRequestSchema,
} from "@/lib/plan/schemas";
import { PlanError, createPlanNdjsonStream } from "@/lib/plan/stream";
import {
  closeTodoistClient,
  createTodoistClient,
  createTodoistTransport,
  fetchTodoistMetadata,
  syncTasksToTodoist,
} from "@/lib/todoist/mcp-client";
import { detectPriorityFromPrompt } from "@/lib/todoist/priority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  const { env } = getCloudflareContext();
  return handleCorsPreflight(request, env.FRONTEND_ORIGIN);
}

export async function POST(request: NextRequest) {
  const { env } = getCloudflareContext();
  const originResult = resolveRequestOrigin(request, env.FRONTEND_ORIGIN);
  if (!originResult.ok) {
    return originResult.response;
  }
  const { origin } = originResult;

  if (!isJsonContentType(request)) {
    return problemResponse({
      status: 415,
      code: "unsupported_media_type",
      detail: "Content-Type must be application/json",
      headers: buildCorsHeaders(origin),
    });
  }

  if (exceedsDeclaredLength(request, MAX_PLAN_REQUEST_BYTES)) {
    return problemResponse({
      status: 413,
      code: "payload_too_large",
      detail: "Request body exceeds the maximum size of 64KB",
      headers: buildCorsHeaders(origin),
    });
  }

  const body = await readJsonBody(request);
  const parsed = planRequestSchema.safeParse(body);
  if (!parsed.success) {
    return problemResponse({
      status: 400,
      code: "validation_failed",
      errors: zodIssuesToErrors(parsed.error),
      headers: buildCorsHeaders(origin),
    });
  }

  const data = flattenPlanRequest(parsed.data);
  const debugEnabled = isDebugEnabled(env);
  const startedAt = Date.now();

  const stream = createPlanNdjsonStream({
    signal: request.signal,
    debugEnabled,
    async run({ emit, emitDebug, ensureActive, isAborted }) {
      let client: Client | null = null;
      let availableTools: Tool[] | null = null;

      try {
        if (!ensureActive()) {
          return;
        }
        emit({
          type: "stream.open",
          protocol: PLAN_PROTOCOL_VERSION,
          request: { maxTasks: data.maxTasks },
        });

        const transport = createTodoistTransport(env);
        client = transport ? createTodoistClient() : null;
        if (client && transport) {
          try {
            await client.connect(transport);
          } catch (error) {
            throw new PlanError("todoist_unavailable", "Could not reach Todoist", { cause: error });
          }
          try {
            const toolCatalog = await client.listTools();
            availableTools = toolCatalog?.tools ?? null;
            if (availableTools) {
              console.log(
                "[todoist.tools]",
                availableTools.map((tool) => tool.name),
              );
              emitDebug({
                type: "debug.tools",
                tools: availableTools.map((tool) => ({
                  name: tool.name,
                  description: typeof tool.description === "string" ? tool.description : undefined,
                })),
              });
            }
          } catch (error) {
            console.warn("Unable to list Todoist MCP tools", error);
            emitDebug({
              type: "debug.error",
              stage: "tools",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (!ensureActive()) {
          return;
        }
        emit({
          type: "plan.status",
          stage: "ai.init",
          message: "Planning tasks with Workers AI",
        });

        const priorityHint = detectPriorityFromPrompt(data.prompt);
        emit({
          type: "plan.status",
          stage: "intent.detect",
          message: "Analyzing the request intent",
        });

        const intentDecision = await classifyIntent(env, data);
        const scenario = determineScenario(intentDecision, data);
        if (!ensureActive()) {
          return;
        }
        emit({
          type: "plan.status",
          stage: "intent.classified",
          message: `Detected scenario: ${scenario.intent}`,
        });

        const todoistContext = await fetchTodoistMetadata(client, availableTools ?? undefined);
        emitDebug({
          type: "debug.metadata",
          projects: todoistContext.projects,
          labels: todoistContext.labels,
        });

        const inferredProject = inferProjectFromPrompt(data.prompt, todoistContext);
        const inferredLabels = inferLabelsFromPrompt(data.prompt, todoistContext);
        if (!ensureActive()) {
          return;
        }

        let plan: Awaited<ReturnType<typeof generatePlan>>;
        try {
          plan = await generatePlan(
            env,
            data,
            scenario,
            intentDecision,
            todoistContext,
            priorityHint,
            inferredProject,
            inferredLabels,
          );
        } catch (error) {
          if (error instanceof PlanError) {
            throw error;
          }
          throw new PlanError("ai_unavailable", "Workers AI could not generate a plan", {
            cause: error,
          });
        }

        emitDebug({
          type: "debug.inference",
          inferredProject,
          inferredLabels,
          priorityHint,
        });
        if (!ensureActive()) {
          return;
        }

        emit({
          type: "plan.draft",
          summary: plan.summary,
          tasks: plan.tasks,
          intent: scenario.intent,
        });

        const todoistResults = client
          ? await syncTasksToTodoist({
              client,
              tasks: plan.tasks,
              env,
              defaultDue: data.due,
              emit,
              isAborted,
              availableTools: availableTools ?? undefined,
            })
          : plan.tasks.map((task) => ({
              planned: task,
              status: "failed" as const,
              code: "todoist_unavailable",
              error: debugEnabled ? "Todoist MCP client is unavailable" : undefined,
            }));

        if (!ensureActive()) {
          return;
        }

        const created = todoistResults.filter((item) => item.status === "created").length;
        const failed = todoistResults.filter((item) => item.status === "failed").length;
        emit({
          type: "plan.final",
          created,
          failed,
          elapsedMs: Date.now() - startedAt,
          tasks: todoistResults,
        });
      } finally {
        await closeTodoistClient(client);
      }
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
