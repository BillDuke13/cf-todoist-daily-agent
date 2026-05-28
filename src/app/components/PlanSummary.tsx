import type { PlannerEvent } from "../types";
import { IconCheck, IconX } from "./icons";
import styles from "./PlanSummary.module.css";

type FinalEvent = Extract<PlannerEvent, { type: "plan.final" }>;

export function PlanSummary({ final }: { final: FinalEvent }) {
  const total = final.created + final.failed;
  const seconds = Math.round(final.elapsedMs / 100) / 10;
  const allCreated = final.failed === 0;
  const headline = allCreated
    ? `Added ${final.created} task${final.created === 1 ? "" : "s"} to Todoist`
    : `Added ${final.created} of ${total} task${total === 1 ? "" : "s"}`;

  return (
    <div className={styles.summary} data-tone={allCreated ? "success" : "warning"} role="status">
      <span className={styles.icon}>{allCreated ? <IconCheck size={18} /> : <IconX size={18} />}</span>
      <div className={styles.body}>
        <p className={styles.headline}>{headline}</p>
        <p className={styles.detail}>
          {final.failed > 0 ? `${final.failed} failed · ` : ""}
          Completed in {seconds}s
        </p>
      </div>
    </div>
  );
}
