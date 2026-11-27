import type { ErrorCode } from "@/lib/http/errors";

export type PlanEventPayload = { type: string } & Record<string, unknown>;

export class PlanError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlanError";
    this.code = code;
  }
}

export const PLAN_ERROR_MESSAGES: Partial<Record<ErrorCode, string>> & { internal: string } = {
  ai_unavailable: "AI planning is temporarily unavailable",
  todoist_unavailable: "Could not reach Todoist",
  internal: "Failed to generate the plan",
};

export type PlanStreamContext = {
  emit: (event: PlanEventPayload) => void;
  emitDebug: (event: PlanEventPayload) => void;
  ensureActive: () => boolean;
  isAborted: () => boolean;
};

type CreatePlanStreamOptions = {
  signal: AbortSignal;
  debugEnabled: boolean;
  run: (context: PlanStreamContext) => Promise<void>;
};

export function createPlanNdjsonStream({
  signal,
  debugEnabled,
  run,
}: CreatePlanStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let streamClosed = false;
  let streamAborted = signal.aborted;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let seq = 0;

      const safeClose = () => {
        if (streamClosed) {
          return;
        }
        streamClosed = true;
        try {
          controller.close();
        } catch {
          // Consumer already closed or cancelled the stream.
        }
      };

      const emit = (event: PlanEventPayload) => {
        if (streamClosed) {
          return;
        }
        const { type, ...rest } = event;
        const framed = { type, seq: seq++, ts: new Date().toISOString(), ...rest };
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(framed)}\n`));
        } catch {
          streamClosed = true;
        }
      };

      const emitDebug = (event: PlanEventPayload) => {
        if (debugEnabled) {
          emit(event);
        }
      };

      const onAbort = () => {
        streamAborted = true;
      };
      signal.addEventListener("abort", onAbort);

      const ensureActive = () => {
        if (streamAborted) {
          safeClose();
          return false;
        }
        return true;
      };

      (async () => {
        try {
          await run({
            emit,
            emitDebug,
            ensureActive,
            isAborted: () => streamAborted,
          });
        } catch (error) {
          if (streamAborted) {
            return;
          }
          console.error("/plan failed", error);
          const code: ErrorCode = error instanceof PlanError ? error.code : "internal";
          const rawDetail =
            error instanceof PlanError && error.cause instanceof Error
              ? error.cause.message
              : error instanceof Error
                ? error.message
                : String(error);
          emit({
            type: "plan.error",
            code,
            message: PLAN_ERROR_MESSAGES[code] ?? PLAN_ERROR_MESSAGES.internal,
            detail: debugEnabled ? rawDetail.slice(0, 500) : undefined,
          });
        } finally {
          signal.removeEventListener("abort", onAbort);
          safeClose();
        }
      })().catch((error) => {
        console.error("Streaming error", error);
        safeClose();
      });
    },
    cancel() {
      streamAborted = true;
      streamClosed = true;
    },
  });
}
