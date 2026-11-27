import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { isDebugEnabled } from "@/lib/cloudflare/env";
import type { NormalizedTask, TodoistTaskResult } from "@/lib/plan/contract";
import type { PlanEventPayload } from "@/lib/plan/stream";
import {
  LABEL_TOOL_ALIASES,
  PROJECT_TOOL_ALIASES,
  extractArrayPayload,
  isBulkCreateTool,
  parseCreateTaskResponse,
  resolveCreateTaskToolName,
  resolveListToolConfig,
  toTodoistTaskArgs,
  type TodoistLabelSummary,
  type TodoistListToolConfig,
  type TodoistMetadata,
  type TodoistProjectSummary,
} from "./mcp-parser";

const MCP_CLIENT_INFO = {
  name: "cf-todoist-daily-agent",
  version: "0.1.0",
};

export function ensureValidUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("TODOIST_MCP_URL must be a valid URL");
  }
}

export function createTodoistTransport(env: CloudflareEnv): StreamableHTTPClientTransport | null {
  if (!env.TODOIST_MCP_URL) {
    console.warn("TODOIST_MCP_URL is not configured. Todoist sync will be skipped.");
    return null;
  }
  const url = ensureValidUrl(env.TODOIST_MCP_URL);
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

export function createTodoistClient(): Client {
  return new Client(MCP_CLIENT_INFO);
}

export async function closeTodoistClient(client: Client | null): Promise<void> {
  try {
    await client?.close();
  } catch (error) {
    console.warn("Failed to close MCP client", error);
  }
}

async function callTodoistListTool(client: Client, config: TodoistListToolConfig): Promise<unknown[]> {
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

export async function fetchTodoistMetadata(
  client: Client | null,
  tools?: Tool[],
): Promise<TodoistMetadata> {
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

  const projectSummaries: TodoistProjectSummary[] = Array.isArray(projects)
    ? (
        projects as Array<{
          id: string;
          name: string;
          is_inbox_project?: boolean;
          inbox_project?: boolean;
          isInbox?: boolean;
        }>
      ).map((project) => ({
        id: project.id,
        name: project.name,
        // MCP server variants expose different inbox flags; fall back to the literal name.
        isInbox:
          Boolean(project.is_inbox_project || project.inbox_project || project.isInbox) ||
          project.name?.toLowerCase() === "inbox",
      }))
    : [];

  const labelSummaries: TodoistLabelSummary[] = Array.isArray(labels)
    ? (labels as Array<{ id: string; name: string }>).map((label) => ({
        id: label.id,
        name: label.name,
      }))
    : [];

  return { projects: projectSummaries, labels: labelSummaries };
}

type SyncTasksOptions = {
  client: Client;
  tasks: NormalizedTask[];
  env: CloudflareEnv;
  defaultDue?: string;
  emit: (event: PlanEventPayload) => void;
  isAborted: () => boolean;
  availableTools?: Tool[];
};

export async function syncTasksToTodoist({
  client,
  tasks,
  env,
  defaultDue,
  emit,
  isAborted,
  availableTools,
}: SyncTasksOptions): Promise<TodoistTaskResult[]> {
  if (!env.TODOIST_TOKEN) {
    throw new Error("TODOIST_TOKEN is required to contact the MCP server");
  }

  const debugEnabled = isDebugEnabled(env);
  const todoistUrl = ensureValidUrl(env.TODOIST_MCP_URL || "");
  let toolsList = availableTools;
  if (!toolsList?.length) {
    const listed = await client.listTools();
    toolsList = listed?.tools ?? [];
  }
  const toolName = resolveCreateTaskToolName(toolsList, todoistUrl);
  const bulk = isBulkCreateTool(toolName);
  const results: TodoistTaskResult[] = [];

  for (const task of tasks) {
    if (isAborted()) {
      break;
    }

    emit({
      type: "todoist.task",
      status: "pending",
      task,
    });

    try {
      const args = toTodoistTaskArgs(task, defaultDue, {
        priorityStyle: bulk ? "string" : "number",
      });
      const payload = bulk ? { tasks: [args] } : args;
      const response = await client.callTool({
        name: toolName,
        arguments: payload,
      });
      const parsed = parseCreateTaskResponse(response);
      results.push({
        planned: task,
        status: "created",
        todoistId: parsed?.id,
      });
      emit({
        type: "todoist.task",
        status: "created",
        task,
        todoistId: parsed?.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        planned: task,
        status: "failed",
        code: "todoist_sync_failed",
        error: debugEnabled ? message : undefined,
      });
      emit({
        type: "todoist.task",
        status: "failed",
        task,
        code: "todoist_sync_failed",
        detail: debugEnabled ? message.slice(0, 500) : undefined,
      });
    }
  }

  return results;
}
