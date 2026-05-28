import { type CSSProperties } from "react";
import { priorityToUiLabel } from "@/lib/priority";
import type { NormalizedTask, TaskState, TaskSyncStatus } from "../types";
import { IconCalendar, IconCheck, IconFlag, IconFolder, IconSpinner, IconTag, IconX } from "./icons";
import styles from "./TaskCard.module.css";

const SYNC_TEXT: Record<TaskSyncStatus, string> = {
  queued: "Queued",
  pending: "Syncing…",
  created: "Added to Todoist",
  failed: "Not added",
};

export function TaskCard({ state, index }: { state: TaskState; index: number }) {
  const { task, status, todoistId, error } = state;
  const priority = priorityToUiLabel(task.priority);
  const due = formatDue(task.due);
  const hasMeta = Boolean(task.projectName || due || task.labels?.length);

  return (
    <li className={styles.card} style={{ "--index": index } as CSSProperties}>
      <div className={styles.head}>
        <p className={styles.title}>{task.title}</p>
        {priority && (
          <span className={styles.priority} data-level={priority.level} title={`Priority ${priority.label}`}>
            <IconFlag size={12} />
            {priority.label}
          </span>
        )}
      </div>

      {task.description && <p className={styles.description}>{task.description}</p>}

      {hasMeta && (
        <div className={styles.meta}>
          {task.projectName && (
            <span className={styles.chip}>
              <IconFolder size={12} />
              {task.projectName}
            </span>
          )}
          {due && (
            <span className={styles.chip}>
              <IconCalendar size={12} />
              {due}
            </span>
          )}
          {task.labels?.map((label) => (
            <span key={label} className={styles.chip}>
              <IconTag size={12} />
              {label}
            </span>
          ))}
        </div>
      )}

      <p className={styles.sync} data-status={status}>
        <SyncIcon status={status} />
        <span>
          {SYNC_TEXT[status]}
          {status === "created" && todoistId ? ` · #${todoistId}` : ""}
        </span>
        {status === "failed" && error && <span className={styles.syncError}>{error}</span>}
      </p>
    </li>
  );
}

function SyncIcon({ status }: { status: TaskSyncStatus }) {
  switch (status) {
    case "pending":
      return <IconSpinner size={14} />;
    case "created":
      return <IconCheck size={14} />;
    case "failed":
      return <IconX size={14} />;
    default:
      return <span className={styles.dot} aria-hidden="true" />;
  }
}

function formatDue(due?: NormalizedTask["due"]): string | undefined {
  if (!due) {
    return undefined;
  }
  if (due.datetime) {
    const parsed = new Date(due.datetime);
    return Number.isNaN(parsed.getTime())
      ? due.datetime
      : parsed.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
  }
  if (due.date) {
    const parsed = new Date(`${due.date}T00:00:00`);
    return Number.isNaN(parsed.getTime())
      ? due.date
      : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  return due.string;
}
