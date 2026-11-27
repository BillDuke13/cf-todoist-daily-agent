import type { TodoistMetadata, TodoistProjectSummary } from "@/lib/todoist/mcp-parser";
import { clampPriority, dedupeLabels } from "@/lib/todoist/priority";
import type { NormalizedTask } from "./contract";
import type { PlanRequestInput, PlannedTask } from "./schemas";

export function resolveProjectReference(
  task: PlannedTask,
  context: TodoistMetadata,
  inferred?: TodoistProjectSummary | null,
) {
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
    const known = context.projects.find(
      (project) => project.name.toLowerCase() === normalized.toLowerCase(),
    );
    if (known) {
      return known;
    }
    return { id: undefined, name: normalized };
  }
  return inferred || undefined;
}

export function normalizeLabels(
  preferred: string[] | undefined,
  fallback: string[] | undefined,
  context: TodoistMetadata,
  inferred?: string[],
): string[] | undefined {
  const source = preferred?.length ? preferred : (fallback ?? inferred);
  if (!source?.length) {
    return undefined;
  }
  const normalized = source
    .map((label) => {
      const trimmed = label.trim();
      if (!trimmed) {
        return undefined;
      }
      const canonical = context.labels.find(
        (entry) => entry.name.toLowerCase() === trimmed.toLowerCase(),
      );
      return canonical?.name ?? trimmed;
    })
    .filter((value): value is string => Boolean(value));
  return dedupeLabels(normalized);
}

export function selectDue(
  fromTask?: PlannedTask["due"],
  fallback?: string,
): NormalizedTask["due"] | undefined {
  if (!fromTask && !fallback) {
    return undefined;
  }
  if (fromTask?.datetime) {
    return { datetime: fromTask.datetime };
  }
  if (fromTask?.date) {
    return { date: fromTask.date };
  }
  if (fromTask?.string) {
    return { string: fromTask.string };
  }
  if (fallback) {
    return { string: fallback };
  }
  return undefined;
}

export function normalizeTask(
  task: PlannedTask,
  input: PlanRequestInput,
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
