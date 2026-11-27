import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  LABEL_TOOL_ALIASES,
  PROJECT_TOOL_ALIASES,
  extractArrayPayload,
  isBulkCreateTool,
  matchesListTool,
  parseCreateTaskResponse,
  resolveCreateTaskToolName,
  resolveListToolConfig,
  toTodoistTaskArgs,
} from "@/lib/todoist/mcp-parser";

function makeTool(name: string, description = ""): Tool {
  return { name, description, inputSchema: { type: "object" } };
}

describe("MCP tool discovery", () => {
  it("matches non-mutating list tools by keyword and rejects mutating verbs", () => {
    expect(matchesListTool(makeTool("browse-projects", "List all projects"), ["project"])).toBe(true);
    expect(matchesListTool(makeTool("create-project", "Add a project"), ["project"])).toBe(false);
    expect(matchesListTool(makeTool("delete-project", "List and delete"), ["project"])).toBe(false);
  });

  it("resolves project and label tools by alias precedence", () => {
    const tools = [
      makeTool("find-projects"),
      makeTool("todoist_projects"),
      makeTool("find-labels"),
    ];
    expect(resolveListToolConfig(tools, PROJECT_TOOL_ALIASES)).toEqual({
      name: "todoist_projects",
      args: { action: "list", include_archived: false },
      resultKeys: ["data", "projects"],
    });
    expect(resolveListToolConfig(tools, LABEL_TOOL_ALIASES)).toEqual({
      name: "find-labels",
      args: undefined,
      resultKeys: ["labels", "data"],
    });
  });

  it("selects create-task tool by preference order and throws when absent", () => {
    const url = new URL("https://ai.todoist.net/mcp");
    expect(resolveCreateTaskToolName([makeTool("add-tasks"), makeTool("add-task")], url)).toBe(
      "add-task",
    );
    expect(resolveCreateTaskToolName([makeTool("add-tasks")], url)).toBe("add-tasks");
    expect(isBulkCreateTool("add-tasks")).toBe(true);
    expect(isBulkCreateTool("add-task")).toBe(false);
    expect(() => resolveCreateTaskToolName([makeTool("find-projects")], url)).toThrow(
      /No Todoist create task tool found/,
    );
  });
});

describe("toTodoistTaskArgs", () => {
  it("formats numeric priority, dual project IDs, and due precedence", () => {
    const args = toTodoistTaskArgs(
      {
        title: "Ship release",
        description: "Tag v2",
        priority: 4,
        labels: ["work"],
        projectId: "proj-1",
        due: { date: "2026-11-27", string: "tomorrow" },
      },
      "today",
      { priorityStyle: "number" },
    );

    expect(args).toEqual({
      content: "Ship release",
      description: "Tag v2",
      priority: 4,
      labels: ["work"],
      projectId: "proj-1",
      project_id: "proj-1",
      dueDate: "2026-11-27",
    });
  });

  it("formats string priority flags for bulk tools and falls back to default due string", () => {
    const args = toTodoistTaskArgs({ title: "Buy milk", priority: 3 }, "today 6pm", {
      priorityStyle: "string",
    });
    expect(args).toEqual({
      content: "Buy milk",
      priority: "p2",
      dueString: "today 6pm",
    });
  });
});

describe("MCP response parsing", () => {
  it("extracts arrays from structuredContent, json blocks, and fenced text", () => {
    expect(extractArrayPayload({ structuredContent: { projects: [{ id: "1" }] } })).toEqual([
      { id: "1" },
    ]);
    expect(
      extractArrayPayload({
        content: [{ type: "text", text: '```json\n{"labels":[{"id":"l1"}]}\n```' }],
      }),
    ).toEqual([{ id: "l1" }]);
  });

  it("extracts task IDs from id, task_id, uuid, or plain text fallback", () => {
    expect(parseCreateTaskResponse({ structuredContent: { task_id: "t-123" } })).toEqual({
      id: "t-123",
    });
    expect(parseCreateTaskResponse({ content: [{ type: "text", text: "Created task" }] })).toEqual({
      id: undefined,
      message: "Created task",
    });
  });
});
