import { type FormEvent } from "react";
import { IconMic, IconSend, IconSpinner, IconStop } from "./icons";
import styles from "./PromptComposer.module.css";

type VoiceState = {
  supported: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  status: string | null;
  error: string | null;
  toggle: () => void;
};

type PromptComposerProps = {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isStreaming: boolean;
  timezone: string;
  maxTasks: number;
  examples: string[];
  voice: VoiceState;
};

export function PromptComposer({
  prompt,
  onPromptChange,
  onSubmit,
  onCancel,
  isStreaming,
  timezone,
  maxTasks,
  examples,
  voice,
}: PromptComposerProps) {
  const canSubmit = prompt.trim().length > 0 && !isStreaming;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    onSubmit();
  }

  const voiceDisabled = !voice.supported || voice.isTranscribing || (isStreaming && !voice.isRecording);

  return (
    <section className={styles.composer} aria-labelledby="composer-heading">
      <header className={styles.header}>
        <h2 id="composer-heading" className={styles.heading}>
          Describe your day
        </h2>
        <p className={styles.sub}>
          Write or speak in plain language. The agent infers task titles, projects, labels,
          priorities, and due times for you.
        </p>
      </header>

      <form className={styles.form} onSubmit={handleSubmit}>
        <label htmlFor="prompt" className="srOnly">
          Planning request
        </label>
        <textarea
          id="prompt"
          name="prompt"
          required
          minLength={1}
          placeholder="e.g. Prep the briefing deck, follow up with the design team, and block an hour to review KPIs before 5pm."
          className={styles.input}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
        />

        {examples.length > 0 && (
          <div className={styles.examples}>
            <span className={styles.examplesLabel}>Try:</span>
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                className={styles.example}
                onClick={() => onPromptChange(example)}
                disabled={isStreaming}
              >
                {example}
              </button>
            ))}
          </div>
        )}

        <p className={styles.meta}>
          <span>Timezone: {timezone || "auto-detected"}</span>
          <span aria-hidden="true">·</span>
          <span>Up to {maxTasks} tasks per run</span>
        </p>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.voiceButton}
            onClick={voice.toggle}
            disabled={voiceDisabled}
            aria-pressed={voice.isRecording}
          >
            {voice.isRecording ? (
              <>
                <IconStop size={16} />
                Stop recording
              </>
            ) : voice.isTranscribing ? (
              <>
                <IconSpinner size={16} />
                Transcribing…
              </>
            ) : (
              <>
                <IconMic size={16} />
                Use voice
              </>
            )}
          </button>

          <div className={styles.primaryActions}>
            {isStreaming && (
              <button type="button" className={styles.secondary} onClick={onCancel}>
                Cancel
              </button>
            )}
            <button type="submit" className={styles.submit} disabled={!canSubmit} aria-busy={isStreaming}>
              {isStreaming ? <IconSpinner size={16} /> : <IconSend size={16} />}
              {isStreaming ? "Planning…" : "Plan my day"}
            </button>
          </div>
        </div>

        <div className={styles.voiceMessages} aria-live="polite">
          {!voice.supported && (
            <p className={styles.voiceHint}>Voice capture is not supported in this browser.</p>
          )}
          {voice.status && <p className={styles.voiceStatus}>{voice.status}</p>}
          {voice.error && (
            <p className={styles.voiceError} role="alert">
              {voice.error}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
