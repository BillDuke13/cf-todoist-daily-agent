import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { NormalizedTask } from "@/lib/plan/contract";
import { stripJsonFence } from "@/lib/plan/ai-response";
import { mapApiPriorityToUiFlag } from "./priority";

export type TodoistProjectSummary = {
  id: string;
  name: string;
  isInbox: boolean;
};

export type TodoistLabelSummary = {
  id: string;
  name: string;
};

export type TodoistMetadata = {
  projects: TodoistProjectSummary[];
  labels: TodoistLabelSummary[];
};

export type TodoistListToolAlias = {
  names?: string[];
  match?: (tool: Tool) => boolean;
  buildArgs?: (toolName: string, tool: Tool) => Record<string, unknown> | undefined;
  resultKeys?: string[];
};

export type TodoistListToolConfig = {
  name: string;
  args?: Record<string, unknown>;
  resultKeys?: string[];
};

const DEFAULT_COLLECTION_KEYS = [
  "projects",
  "labels",
  "data",
  "items",
  "results",
  "structuredContent",
] as const;

const LIST_VERB_KEYWORDS = ["list", "find", "search", "get", "overview", "browse", "view", "all"];
const MUTATING_KEYWORDS = [
  "add",
  "create",
  "update",
  "delete",
  "remove",
  "complete",
  "close",
  "assign",
  "set",
  "comment",
];

const CREATE_TASK_TOOL_PREFERENCE = [
  "create_task",
  "add-task",
  "add_task",
  "create-task",
  "add-tasks",
  "add_tasks",
] as const;

export const PROJECT_TOOL_ALIASES: TodoistListToolAlias[] = [
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

export const LABEL_TOOL_ALIASES: TodoistListToolAlias[] = [
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

function buildToolText(tool: Tool): string {
  const description = typeof tool.description === "string" ? tool.description : "";
  return `${tool.name ?? ""} ${description}`.toLowerCase();
}

export function matchesListTool(tool: Tool, keywords: string[]): boolean {
  const text = buildToolText(tool);
  if (!keywords.some((keyword) => text.includes(keyword))) {
    return false;
  }
  if (!LIST_VERB_KEYWORDS.some((verb) => text.includes(verb))) {
    return false;
  }
  return !MUTATING_KEYWORDS.some((verb) => text.includes(verb));
}

export function resolveListToolConfig(
  tools: Tool[],
  aliases: TodoistListToolAlias[],
): TodoistListToolConfig | null {
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

export function resolveCreateTaskToolName(tools: Tool[], url: URL): string {
  for (const candidate of CREATE_TASK_TOOL_PREFERENCE) {
    if (tools.some((tool) => tool.name === candidate)) {
      return candidate;
    }
  }
  const available = tools.map((tool) => tool.name).join(", ");
  throw new Error(
    `No Todoist create task tool found. Available tools: ${available || "none"} @ ${url.toString()}`,
  );
}

export function isBulkCreateTool(toolName: string): boolean {
  return toolName === "add-tasks" || toolName === "add_tasks";
}

export function toTodoistTaskArgs(
  task: NormalizedTask,
  defaultDue?: string,
  options: { priorityStyle: "number" | "string" } = { priorityStyle: "number" },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    content: task.title,
  };

  if (task.description) {
    payload.description = task.description;
  }
  if (typeof task.priority === "number") {
    payload.priority =
      options.priorityStyle === "string"
        ? mapApiPriorityToUiFlag(task.priority)
        : task.priority;
  }
  if (task.labels) {
    payload.labels = task.labels;
  }
  if (task.projectId) {
    // Send both snake_case (official MCP) and camelCase (legacy/community servers).
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
  } else if (defaultDue) {
    payload.dueString = defaultDue;
  }

  return payload;
}

function extractStructuredContent(response: unknown): unknown {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const payload = response as { structuredContent?: unknown; structured_content?: unknown };
  if (payload.structuredContent !== undefined) {
    return payload.structuredContent;
  }
  return payload.structured_content;
}

function extractToolJsonBlock(response: unknown): unknown {
  const message = response as {
    content?: Array<{ type?: string; json?: unknown; text?: string; mimeType?: string }>;
  };
  const jsonEntry = message.content?.find((item) => item.type === "json");
  if (jsonEntry?.json !== undefined) {
    return jsonEntry.json;
  }
  const jsonTextEntry = message.content?.find((item) => item.mimeType === "application/json");
  return jsonTextEntry?.text;
}

function extractToolText(response: unknown): string | undefined {
  const message = response as {
    content?: Array<{ type?: string; text?: string; mimeType?: string } | unknown>;
  };
  const textBlocks = message.content?.filter(
    (item): item is { type: "text"; text?: string; mimeType?: string } =>
      typeof item === "object" && item !== null && (item as { type?: string }).type === "text",
  );
  if (!textBlocks?.length) {
    return undefined;
  }
  const plainTextBlock = textBlocks.find(
    (block) => block.mimeType !== "application/json" && Boolean(block.text),
  );
  const target = plainTextBlock ?? textBlocks.find((block) => Boolean(block.text));
  return target?.text ? stripJsonFence(target.text) : undefined;
}

export function parseToolJson<T>(response: unknown): T | undefined {
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

export function extractArrayPayload(response: unknown, preferredKeys?: string[]): unknown[] {
  const parsed = parseToolJson<unknown>(response);
  const keys = preferredKeys ?? Array.from(DEFAULT_COLLECTION_KEYS);
  const direct = pluckArray(parsed, keys);
  return Array.isArray(direct) ? direct : [];
}

export function parseCreateTaskResponse(response: unknown): { id?: string; message?: string } | undefined {
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
