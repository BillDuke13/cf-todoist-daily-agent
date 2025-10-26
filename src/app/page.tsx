"use client";

import { type Dispatch, type FormEvent, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";

type PlannerEvent =
  | {
      type: "status";
      stage: string;
      message: string;
      timestamp: string;
    }
  | {
      type: "ai.plan";
      summary?: string;
      tasks: NormalizedTask[];
      intent?: string;
      timestamp: string;
    }
  | {
      type: "todoist.task";
      status: "pending" | "created" | "failed";
      task: NormalizedTask;
      todoistId?: string;
      error?: string;
      timestamp: string;
    }
  | {
      type: "final";
      created: number;
      failed: number;
      tasks: TodoistTaskResult[];
      elapsedMs: number;
      timestamp: string;
    }
  | {
      type: "error";
      message: string;
      detail?: string;
      timestamp: string;
    };

type NormalizedTask = {
  title: string;
  description?: string;
  priority?: number;
  labels?: string[];
  due?: {
    string?: string;
    date?: string;
    datetime?: string;
  };
  projectName?: string;
};

type TodoistTaskResult = {
  planned: NormalizedTask;
  status: "created" | "failed";
  todoistId?: string;
  error?: string;
};

const defaultTimezone =
  typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
const MAX_AUTOMATED_TASKS = 6;
const VOICE_TIMEOUT_MS = 60_000;

/**
 * Primary SPA surface that submits prompts to `/plan`, renders streamed NDJSON events,
 * and offers a short voice capture UX backed by `/api/transcribe`.
 */
export default function Home() {
  const [events, setEvents] = useState<PlannerEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const recordingTimeoutRef = useRef<number | null>(null);
  const skipUploadRef = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  const finalEvent = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === "final") {
        return event;
      }
    }
    return undefined;
  }, [events]);

  const todoistEvents = useMemo(
    () => events.filter((event): event is Extract<PlannerEvent, { type: "todoist.task" }> => event.type === "todoist.task"),
    [events],
  );

  const supportsVoiceInput =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "mediaDevices" in navigator &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.MediaRecorder !== "undefined";

  useEffect(() => {
    return () => {
      stopRecording({ skipTranscription: true });
      stopStreamTracks();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Posts the prompt to `/plan`, incrementally decodes NDJSON chunks, and feeds the
   * resulting events into local state so the timeline updates as soon as data arrives.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    abortControllerRef.current?.abort();

    let payload: Record<string, unknown>;
    try {
      payload = buildPayload(prompt);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }

    setErrorMessage(null);
    setEvents([]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch("/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error("The server did not return a stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Read one chunk at a time so the UI can react between NDJSON lines.
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
  }

  function handleCancel() {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsStreaming(false);
  }

  /**
   * Toggles the MediaRecorder session, streams microphone data into memory, and hands
   * the base64 clip to `/api/transcribe` so the resulting text can immediately reuse
   * the regular submission path.
   */
  async function handleVoiceButton() {
    if (isRecording) {
      stopRecording();
      return;
    }
    if (!supportsVoiceInput) {
      setVoiceError("Voice capture is not supported in this browser.");
      return;
    }
    if (isStreaming) {
      setVoiceError("Please wait for the current plan to finish before starting a new recording.");
      return;
    }
    try {
      setVoiceError(null);
      setVoiceStatus("Requesting microphone access…");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = selectMimeType();
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = async () => {
        clearRecordingTimeout();
        stopStreamTracks();
        setIsRecording(false);
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        if (skipUploadRef.current) {
          skipUploadRef.current = false;
          setVoiceStatus(null);
          return;
        }
        if (!blob.size) {
          setVoiceStatus(null);
          setVoiceError("No audio was captured.");
          return;
        }
        await transcribeAudio(blob);
      };
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setVoiceStatus("Recording… tap again to stop");
      recordingTimeoutRef.current = window.setTimeout(() => {
        setVoiceStatus("Recording stopped after 60 seconds.");
        stopRecording();
      }, VOICE_TIMEOUT_MS);
    } catch (error) {
      console.error("Voice capture failed", error);
      setVoiceStatus(null);
      setVoiceError(error instanceof Error ? error.message : "Unable to access the microphone");
      stopStreamTracks();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        skipUploadRef.current = true;
        mediaRecorderRef.current.stop();
      }
    }
  }

  function stopRecording(options?: { skipTranscription?: boolean }) {
    if (!mediaRecorderRef.current) {
      return;
    }
    clearRecordingTimeout();
    if (options?.skipTranscription) {
      skipUploadRef.current = true;
    }
    if (mediaRecorderRef.current.state === "inactive") {
      skipUploadRef.current = false;
      stopStreamTracks();
      setIsRecording(false);
      return;
    }
    mediaRecorderRef.current.stop();
  }

  function stopStreamTracks() {
    if (!mediaStreamRef.current) {
      return;
    }
    for (const track of mediaStreamRef.current.getTracks()) {
      track.stop();
    }
    mediaStreamRef.current = null;
  }

  function clearRecordingTimeout() {
    if (recordingTimeoutRef.current) {
      window.clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
  }

  function selectMimeType() {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      return "audio/webm;codecs=opus";
    }
    return "audio/webm";
  }

  async function transcribeAudio(blob: Blob) {
    setIsTranscribing(true);
    setVoiceStatus("Transcribing audio…");
    setVoiceError(null);
    let transcriptApplied = false;
    try {
      const base64 = await blobToBase64(blob);
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ audio: base64 }),
      });
      const payload = (await response.json()) as { text?: string; error?: string };
      if (!response.ok || !payload.text) {
        throw new Error(payload.error || "Unable to transcribe audio");
      }
      await applyTranscriptAndSubmit(payload.text);
      transcriptApplied = true;
      setVoiceStatus("Transcription ready");
      window.setTimeout(() => setVoiceStatus(null), 2500);
    } catch (error) {
      console.error("Transcription failed", error);
      setVoiceError(error instanceof Error ? error.message : "Unable to transcribe audio");
      setVoiceStatus(null);
    } finally {
      setIsTranscribing(false);
      if (!transcriptApplied) {
        setVoiceStatus(null);
      }
    }
  }

  async function applyTranscriptAndSubmit(text: string) {
    const normalized = text.trim();
    if (!normalized.length) {
      setVoiceError("Transcription was empty. Please try again.");
      return;
    }
    setPrompt(normalized);
    await waitForNextFrame();
    formRef.current?.requestSubmit();
  }

  function waitForNextFrame() {
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <section className={styles.hero}>
          <h1>Todoist Daily Planner</h1>
          <p>Gather a focused plan, stream its progress, and push the resulting tasks through the MCP pipeline.</p>
        </section>

        <section className={`${styles.panel} ${styles.dialogPanel}`}>
          <div className={styles.dialogShell} role="dialog" aria-label="Daily plan composer">
            <div className={styles.dialogHeader}>
              <p className={styles.dialogBadge}>Single prompt</p>
              <h2>Describe your day once</h2>
              <p>Write in natural language and the model will infer task names, Todoist sections, priorities, and due times.</p>
            </div>
            <form ref={formRef} className={styles.dialogForm} onSubmit={handleSubmit}>
              <label className={styles.promptLabel} htmlFor="prompt">
                Planning request
                <textarea
                  id="prompt"
                  name="prompt"
                  required
                  minLength={3}
                  placeholder="E.g. prep briefing deck, follow up with design team, schedule physical therapy, block time to review KPIs."
                  className={styles.promptInput}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>
              <p className={styles.dialogHint}>
                The agent auto-fills Todoist MCP arguments. Include any context about owners, constraints, or focus windows and it will map those to
                labels, projects, and due details.
              </p>
              <div className={styles.dialogMeta}>
                <span>Timezone: {defaultTimezone || "auto-detected"}</span>
                <span>Up to {MAX_AUTOMATED_TASKS} tasks per run · streaming NDJSON output.</span>
              </div>
              <div className={styles.voiceControls}>
                <button
                  type="button"
                  className={styles.voiceButton}
                  onClick={handleVoiceButton}
                  disabled={!supportsVoiceInput || isTranscribing || (!isRecording && isStreaming)}
                  aria-pressed={isRecording}
                >
                  {isRecording ? "Stop recording" : isTranscribing ? "Transcribing…" : "Use voice input"}
                </button>
                <div className={styles.voiceMessages}>
                  {!supportsVoiceInput && <p className={styles.voiceHint}>Voice capture is not supported in this browser.</p>}
                  {voiceStatus && <p className={styles.voiceStatus}>{voiceStatus}</p>}
                  {voiceError && <p className={styles.voiceError}>{voiceError}</p>}
                </div>
              </div>
              <div className={styles.actions}>
                <button type="submit" disabled={isStreaming}>
                  {isStreaming ? "Planning..." : "Send to planner"}
                </button>
                <button type="button" onClick={handleCancel} disabled={!isStreaming}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </section>

        <section className={styles.panel}>
          <header className={styles.panelHeader}>
            <h2>Streaming log</h2>
            {isStreaming && <span className={styles.badge}>Live</span>}
          </header>
          {errorMessage && <p className={styles.error}>{errorMessage}</p>}
          <ol className={styles.eventList}>
            {events.map((event, index) => (
              <li key={`${event.type}-${index}`} className={styles.eventItem}>
                {renderEvent(event)}
              </li>
            ))}
            {!events.length && <li className={styles.eventPlaceholder}>Submit a request to watch the Worker stream events.</li>}
          </ol>
        </section>

        {finalEvent && (
          <section className={styles.panel}>
            <header className={styles.panelHeader}>
              <h2>Todoist summary</h2>
            </header>
            <p>
              Created {finalEvent.created} task{finalEvent.created === 1 ? "" : "s"}, failed {finalEvent.failed}. Total runtime {Math.round(finalEvent.elapsedMs / 100) / 10}s.
            </p>
            <ul className={styles.taskList}>
              {finalEvent.tasks.map((task, index) => (
                <li key={`${task.planned.title}-${index}`}>
                  <strong>{task.planned.title}</strong>
                  {task.planned.projectName && <span className={styles.taskMeta}>[{task.planned.projectName}]</span>}
                  {task.todoistId && <span className={styles.taskMeta}>#{task.todoistId}</span>}
                  <span className={task.status === "created" ? styles.success : styles.warning}>{task.status}</span>
                  {task.error && <span className={styles.taskMeta}>{task.error}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {!!todoistEvents.length && (
          <section className={styles.panel}>
            <header className={styles.panelHeader}>
              <h2>Task timeline</h2>
            </header>
            <ol className={styles.timeline}>
              {todoistEvents.map((event, index) => (
                <li key={`${event.task.title}-${index}`}>
                  <span className={styles.timelineBadge} data-status={event.status} />
                  <div>
                    <strong>{event.task.title}</strong>
                    <p className={styles.timelineMeta}>
                      {new Date(event.timestamp).toLocaleTimeString()} · {event.status}
                      {event.todoistId && ` · #${event.todoistId}`}
                    </p>
                    {event.error && <p className={styles.errorInline}>{event.error}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </main>
      <footer className={styles.footer}>Built for the Todoist MCP workflow on Cloudflare Workers.</footer>
    </div>
  );
}

function buildPayload(promptValue: string) {
  const prompt = promptValue.trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const payload: Record<string, unknown> = {
    prompt,
    maxTasks: MAX_AUTOMATED_TASKS,
  };

  if (defaultTimezone) {
    payload.timezone = defaultTimezone;
  }

  return payload;
}

/**
 * Consumes newline-delimited chunks from the streaming buffer and forwards each line
 * to the provided callback while returning whatever partial line remains.
 */
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

/**
 * Parses a single NDJSON line and appends it to the planner timeline. Invalid lines
 * are ignored so the UI never crashes on unexpected debug payloads.
 */
function enqueueEvent(line: string, setEvents: Dispatch<SetStateAction<PlannerEvent[]>>) {
  try {
    const parsed = JSON.parse(line) as PlannerEvent;
    setEvents((current) => [...current, parsed]);
  } catch (error) {
    console.error("Unable to parse stream chunk", error, line);
  }
}

function renderEvent(event: PlannerEvent) {
  switch (event.type) {
    case "status":
      return (
        <>
          <strong>{event.message}</strong>
          <span className={styles.meta}>{new Date(event.timestamp).toLocaleTimeString()}</span>
        </>
      );
    case "ai.plan":
      return (
        <div>
          <strong>AI plan ready</strong>
          {event.intent && <p className={styles.meta}>Intent: {event.intent}</p>}
          {event.summary && <p className={styles.meta}>{event.summary}</p>}
          <p className={styles.meta}>{event.tasks.length} task(s)</p>
        </div>
      );
    case "todoist.task":
      return (
        <div>
          <strong>{event.task.title}</strong>
          <p className={styles.meta}>
            {event.status}
            {event.todoistId && ` · #${event.todoistId}`}
            {event.task.projectName && ` · ${event.task.projectName}`}
            {event.error && ` · ${event.error}`}
          </p>
        </div>
      );
    case "final":
      return (
        <div>
          <strong>Completed</strong>
          <p className={styles.meta}>
            Created {event.created}, failed {event.failed}. {Math.round(event.elapsedMs / 100) / 10}s total
          </p>
        </div>
      );
    case "error":
      return (
        <div>
          <strong className={styles.error}>Error</strong>
          <p className={styles.meta}>{event.message}</p>
          {event.detail && <p className={styles.meta}>{event.detail}</p>}
        </div>
      );
    default:
      return null;
  }
}

async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
