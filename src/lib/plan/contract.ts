export const PLAN_PROTOCOL_VERSION = "1.0";

export type IntentType =
  | "single_reminder"
  | "multi_step_plan"
  | "recipe_plan"
  | "general_plan";

export type PlanStatusStage = "ai.init" | "intent.detect" | "intent.classified";

export type NormalizedTask = {
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

export type TodoistTaskResult = {
  planned: NormalizedTask;
  status: "created" | "failed";
  todoistId?: string;
  code?: string;
  // Raw failure detail is only populated when DEBUG_EVENTS=true.
  error?: string;
};

// Versioned NDJSON wire events emitted by POST /plan.
// Clients must ignore unknown types such as DEBUG_EVENTS-gated `debug.*` frames.
export type PlannerEvent =
  | {
      type: "stream.open";
      seq: number;
      ts: string;
      protocol: string;
      request?: { maxTasks?: number };
    }
  | {
      type: "plan.status";
      seq: number;
      ts: string;
      stage: PlanStatusStage;
      message: string;
    }
  | {
      type: "plan.draft";
      seq: number;
      ts: string;
      summary?: string;
      tasks: NormalizedTask[];
      intent?: string;
    }
  | {
      type: "todoist.task";
      seq: number;
      ts: string;
      status: "pending" | "created" | "failed";
      task: NormalizedTask;
      todoistId?: string;
      code?: string;
      detail?: string;
    }
  | {
      type: "plan.final";
      seq: number;
      ts: string;
      created: number;
      failed: number;
      tasks: TodoistTaskResult[];
      elapsedMs: number;
    }
  | {
      type: "plan.error";
      seq: number;
      ts: string;
      code: string;
      message: string;
      detail?: string;
    };
