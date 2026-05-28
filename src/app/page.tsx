"use client";

import { useCallback, useState } from "react";
import { PlanStream } from "./components/PlanStream";
import { PromptComposer } from "./components/PromptComposer";
import { usePlanStream } from "./hooks/usePlanStream";
import { useVoiceCapture } from "./hooks/useVoiceCapture";
import styles from "./page.module.css";

const defaultTimezone =
  typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
const MAX_AUTOMATED_TASKS = 6;

const EXAMPLE_PROMPTS = [
  "Plan a focused work morning with three deep-work blocks",
  "3-day vegetarian dinner prep",
  "Remind me to call the dentist at 2pm tomorrow",
  "Afternoon errands: groceries, pharmacy, post office",
];

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const { start, cancel, isStreaming, hasActivity, steps, intent, summary, taskStates, final, error, errorDetail } =
    usePlanStream();

  const runPlan = useCallback(
    (promptText: string) => {
      const trimmed = promptText.trim();
      if (!trimmed) {
        return;
      }
      const payload: Record<string, unknown> = {
        input: { prompt: trimmed },
        limits: { maxTasks: MAX_AUTOMATED_TASKS },
      };
      if (defaultTimezone) {
        payload.scheduling = { timezone: defaultTimezone };
      }
      void start(payload);
    },
    [start],
  );

  const voice = useVoiceCapture({
    disabled: isStreaming,
    onTranscript: (text) => {
      setPrompt(text);
      runPlan(text);
    },
  });

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <header className={styles.hero}>
          <h1 className={styles.title}>Todoist Daily Planner</h1>
          <p className={styles.tagline}>
            Describe your day in one sentence. The agent shapes it into a focused task list and
            pushes it straight into Todoist.
          </p>
        </header>

        <PromptComposer
          prompt={prompt}
          onPromptChange={setPrompt}
          onSubmit={() => runPlan(prompt)}
          onCancel={cancel}
          isStreaming={isStreaming}
          timezone={defaultTimezone}
          maxTasks={MAX_AUTOMATED_TASKS}
          examples={EXAMPLE_PROMPTS}
          voice={voice}
        />

        {hasActivity && (
          <PlanStream
            steps={steps}
            intent={intent}
            summary={summary}
            taskStates={taskStates}
            final={final}
            error={error}
            errorDetail={errorDetail}
            isStreaming={isStreaming}
          />
        )}
      </main>
      <footer className={styles.footer}>Built for the Todoist MCP workflow on Cloudflare Workers.</footer>
    </div>
  );
}
