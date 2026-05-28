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
  // Stable failure discriminator; `error` carries the raw MCP detail and is only
  // populated when DEBUG_EVENTS=true (see src/app/api/plan/route.ts).
  code?: string;
  error?: string;
};

export type PlanStatusStage = "ai.init" | "intent.detect" | "intent.classified";

// Versioned-flat-envelope NDJSON contract for POST /plan. Every event carries a
// monotonic `seq` (starting at 0) and an ISO-8601 `ts`. `type` uses dotted
// `domain.event` naming. Clients must tolerate unknown event types (e.g. the
// DEBUG_EVENTS-gated `debug.*` events, which are not part of this stable union).
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

export type TaskSyncStatus = "queued" | "pending" | "created" | "failed";

export type TaskState = {
  task: NormalizedTask;
  status: TaskSyncStatus;
  todoistId?: string;
  code?: string;
  error?: string;
};

export type StepStatus = "pending" | "active" | "done";

export type PipelineStep = {
  key: string;
  label: string;
  status: StepStatus;
};
