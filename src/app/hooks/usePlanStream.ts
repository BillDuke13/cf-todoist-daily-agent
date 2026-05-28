import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PipelineStep, PlannerEvent, StepStatus, TaskState } from "../types";

export function usePlanStream() {
  const [events, setEvents] = useState<PlannerEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const start = useCallback(async (payload: Record<string, unknown>) => {
    abortControllerRef.current?.abort();

    setErrorMessage(null);
    setEvents([]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch("/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error("The server did not return a stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = flushLines(buffer, (line) => enqueueEvent(line, setEvents));
      }

      if (buffer.trim().length) {
        enqueueEvent(buffer, setEvents);
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      controller.abort();
      abortControllerRef.current = null;
      setIsStreaming(false);
    }
  }, []);

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsStreaming(false);
  }, []);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const plan = useMemo(() => findLast(events, (event) => event.type === "plan.draft"), [events]);
  const finalEvent = useMemo(() => findLast(events, (event) => event.type === "plan.final"), [events]);
  const streamError = useMemo(() => findLast(events, (event) => event.type === "plan.error"), [events]);

  const taskStates = useMemo<TaskState[]>(() => {
    if (finalEvent?.type === "plan.final") {
      return finalEvent.tasks.map((result) => ({
        task: result.planned,
        status: result.status,
        todoistId: result.todoistId,
        code: result.code,
        error: result.error,
      }));
    }
    if (plan?.type !== "plan.draft") {
      return [];
    }
    const settled = events.filter(
      (event): event is Extract<PlannerEvent, { type: "todoist.task" }> =>
        event.type === "todoist.task" && event.status !== "pending",
    );
    const startedCount = events.filter(
      (event) => event.type === "todoist.task" && event.status === "pending",
    ).length;

    return plan.tasks.map((task, index) => {
      if (index < settled.length) {
        const event = settled[index];
        return {
          task,
          status: event.status,
          todoistId: event.todoistId,
          code: event.code,
          error: event.detail,
        };
      }
      if (index < startedCount) {
        return { task, status: "pending" };
      }
      return { task, status: "queued" };
    });
  }, [events, plan, finalEvent]);

  const steps = useMemo<PipelineStep[]>(() => {
    const started = isStreaming || events.length > 0;
    const hasPlan = plan?.type === "plan.draft";
    const hasSync = events.some((event) => event.type === "todoist.task");
    const done = finalEvent?.type === "plan.final";
    const resolve = (active: boolean, complete: boolean): StepStatus =>
      complete ? "done" : active ? "active" : "pending";

    return [
      { key: "understand", label: "Understand request", status: resolve(started && !hasPlan, hasPlan) },
      { key: "draft", label: "Draft tasks", status: resolve(hasPlan && !hasSync && !done, hasSync || done) },
      { key: "sync", label: "Sync to Todoist", status: resolve(hasSync && !done, done) },
      { key: "done", label: "Done", status: done ? "done" : "pending" },
    ];
  }, [events, plan, finalEvent, isStreaming]);

  const intent = plan?.type === "plan.draft" ? plan.intent : undefined;
  const summary = plan?.type === "plan.draft" ? plan.summary : undefined;
  const error = errorMessage ?? (streamError?.type === "plan.error" ? streamError.message : null);
  const errorDetail = streamError?.type === "plan.error" ? streamError.detail : undefined;
  const hasActivity = isStreaming || events.length > 0;

  return {
    start,
    cancel,
    isStreaming,
    hasActivity,
    steps,
    intent,
    summary,
    taskStates,
    final: finalEvent?.type === "plan.final" ? finalEvent : null,
    error,
    errorDetail,
  };
}

function findLast(events: PlannerEvent[], predicate: (event: PlannerEvent) => boolean) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) {
      return events[index];
    }
  }
  return undefined;
}

function flushLines(buffer: string, onLine: (line: string) => void) {
  let remaining = buffer;
  while (true) {
    const newlineIndex = remaining.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }
    const line = remaining.slice(0, newlineIndex).trim();
    remaining = remaining.slice(newlineIndex + 1);
    if (line.length) {
      onLine(line);
    }
  }
  return remaining;
}

function enqueueEvent(line: string, setEvents: React.Dispatch<React.SetStateAction<PlannerEvent[]>>) {
  // Swallow malformed lines and tolerate unknown event types (e.g. debug.*) so an
  // unexpected payload cannot crash the view.
  try {
    const parsed = JSON.parse(line) as PlannerEvent;
    setEvents((current) => [...current, parsed]);
  } catch (error) {
    console.error("Unable to parse stream chunk", error, line);
  }
}
