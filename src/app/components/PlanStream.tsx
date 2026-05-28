import type { PipelineStep, PlannerEvent, TaskState } from "../types";
import { PipelineSteps } from "./PipelineSteps";
import { PlanSummary } from "./PlanSummary";
import { TaskCard } from "./TaskCard";
import styles from "./PlanStream.module.css";

type FinalEvent = Extract<PlannerEvent, { type: "plan.final" }>;

type PlanStreamProps = {
  steps: PipelineStep[];
  intent?: string;
  summary?: string;
  taskStates: TaskState[];
  final: FinalEvent | null;
  error: string | null;
  errorDetail?: string;
  isStreaming: boolean;
};

export function PlanStream({
  steps,
  intent,
  summary,
  taskStates,
  final,
  error,
  errorDetail,
  isStreaming,
}: PlanStreamProps) {
  return (
    <section
      className={styles.stream}
      aria-label="Planning progress"
      aria-busy={isStreaming}
      aria-live="polite"
    >
      <PipelineSteps steps={steps} intent={intent} />

      {error && (
        <div className={styles.error} role="alert">
          <p className={styles.errorTitle}>{error}</p>
          {errorDetail && <p className={styles.errorDetail}>{errorDetail}</p>}
        </div>
      )}

      {summary && <p className={styles.summaryText}>{summary}</p>}

      {taskStates.length > 0 && (
        <ul className={styles.tasks}>
          {taskStates.map((state, index) => (
            <TaskCard key={`${state.task.title}-${index}`} state={state} index={index} />
          ))}
        </ul>
      )}

      {final && <PlanSummary final={final} />}
    </section>
  );
}
