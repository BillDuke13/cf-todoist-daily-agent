import type { PipelineStep } from "../types";
import { IconCheck, IconSpinner } from "./icons";
import styles from "./PipelineSteps.module.css";

const INTENT_LABELS: Record<string, string> = {
  single_reminder: "Reminder",
  multi_step_plan: "Multi-step plan",
  recipe_plan: "Meal plan",
  general_plan: "Daily plan",
};

export function PipelineSteps({ steps, intent }: { steps: PipelineStep[]; intent?: string }) {
  return (
    <ol className={styles.steps}>
      {steps.map((step) => (
        <li key={step.key} className={styles.step} data-status={step.status}>
          <span className={styles.marker}>
            {step.status === "done" ? (
              <IconCheck size={14} />
            ) : step.status === "active" ? (
              <IconSpinner size={14} />
            ) : (
              <span className={styles.dot} aria-hidden="true" />
            )}
          </span>
          <span className={styles.label}>{step.label}</span>
          {step.key === "understand" && intent && (
            <span className={styles.intent}>{intentLabel(intent)}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function intentLabel(intent: string) {
  return INTENT_LABELS[intent] ?? intent.replace(/_/g, " ");
}
