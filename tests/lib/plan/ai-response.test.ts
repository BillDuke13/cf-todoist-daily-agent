import { describe, expect, it } from "vitest";
import {
  extractPlanPayload,
  extractResponsePayload,
  safeJsonParse,
  stripJsonFence,
} from "@/lib/plan/ai-response";

describe("stripJsonFence", () => {
  it("removes leading and trailing markdown code fences", () => {
    expect(stripJsonFence('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
    expect(stripJsonFence('  ```\n{"a": 1}\n```  ')).toBe('{"a": 1}');
  });

  it("returns plain text untouched", () => {
    expect(stripJsonFence('{"a": 1}')).toBe('{"a": 1}');
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON and throws a contextual error on syntax failures", () => {
    expect(safeJsonParse('{"tasks":[]}')).toEqual({ tasks: [] });
    expect(() => safeJsonParse("{invalid")).toThrow(/Workers AI returned invalid JSON/);
  });
});

describe("extractResponsePayload & extractPlanPayload", () => {
  it("extracts pre-parsed chat completion payloads", () => {
    const response = { choices: [{ message: { parsed: { tasks: [{ title: "A" }] } } }] };
    expect(extractResponsePayload(response)).toEqual({ tasks: [{ title: "A" }] });
  });

  it("extracts JSON from Responses API output message blocks with markdown fences", () => {
    const response = {
      output: [
        { type: "reasoning", content: [] },
        {
          type: "message",
          content: [{ text: '```json\n[{"title":"Walk dog"}]\n```' }],
        },
      ],
    };
    expect(extractPlanPayload(response)).toEqual({
      summary: undefined,
      tasks: [{ title: "Walk dog" }],
    });
  });

  it("throws on empty or non-object responses", () => {
    expect(() => extractResponsePayload(null)).toThrow(/empty response/);
    expect(() => extractResponsePayload("raw")).toThrow(/empty response/);
  });
});
