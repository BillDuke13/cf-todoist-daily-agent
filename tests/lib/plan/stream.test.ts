import { describe, expect, it, vi } from "vitest";
import { PlanError, createPlanNdjsonStream } from "@/lib/plan/stream";

async function readNdjson(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    output += decoder.decode(value, { stream: true });
  }
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("createPlanNdjsonStream", () => {
  it("frames events with monotonic seq and omits debug events unless enabled", async () => {
    const controller = new AbortController();
    const stream = createPlanNdjsonStream({
      signal: controller.signal,
      debugEnabled: false,
      async run({ emit, emitDebug }) {
        emit({ type: "stream.open", protocol: "1.0" });
        emitDebug({ type: "debug.tools", tools: [] });
        emit({ type: "plan.status", stage: "ai.init", message: "ok" });
      },
    });

    const events = await readNdjson(stream);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "stream.open", seq: 0, protocol: "1.0" });
    expect(events[1]).toMatchObject({ type: "plan.status", seq: 1, stage: "ai.init" });
    expect(typeof events[0].ts).toBe("string");
  });

  it("redacts error detail in production and includes it when debug is enabled", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const prodStream = createPlanNdjsonStream({
        signal: new AbortController().signal,
        debugEnabled: false,
        async run() {
          throw new PlanError("ai_unavailable", "failed", { cause: new Error("secret trace") });
        },
      });
      const debugStream = createPlanNdjsonStream({
        signal: new AbortController().signal,
        debugEnabled: true,
        async run() {
          throw new PlanError("ai_unavailable", "failed", { cause: new Error("secret trace") });
        },
      });

      const [prodEvent] = await readNdjson(prodStream);
      const [debugEvent] = await readNdjson(debugStream);

      expect(prodEvent).toMatchObject({
        type: "plan.error",
        code: "ai_unavailable",
        message: "AI planning is temporarily unavailable",
      });
      expect(prodEvent.detail).toBeUndefined();
      expect(debugEvent.detail).toBe("secret trace");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("stops cleanly when the request signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = createPlanNdjsonStream({
      signal: controller.signal,
      debugEnabled: false,
      async run({ ensureActive, emit }) {
        if (!ensureActive()) {
          return;
        }
        emit({ type: "stream.open", protocol: "1.0" });
      },
    });

    const events = await readNdjson(stream);
    expect(events).toEqual([]);
  });
});
