import { describe, expect, it } from "vitest";
import { z } from "zod";
import { problemDetails, problemResponse, zodIssuesToErrors } from "@/lib/errors";

describe("problemDetails", () => {
  it("builds an RFC 9457 body with a default title and type URI", () => {
    const problem = problemDetails({ status: 400, code: "validation_failed" });
    expect(problem).toMatchObject({
      type: "/errors/validation_failed",
      title: "Invalid request",
      status: 400,
      code: "validation_failed",
    });
    expect(problem.detail).toBeUndefined();
    expect(problem.errors).toBeUndefined();
  });

  it("includes detail and errors only when provided", () => {
    const problem = problemDetails({
      status: 400,
      code: "validation_failed",
      detail: "bad input",
      errors: [{ field: "input.prompt", message: "Prompt is required" }],
    });
    expect(problem.detail).toBe("bad input");
    expect(problem.errors).toEqual([{ field: "input.prompt", message: "Prompt is required" }]);
  });

  it("omits an empty errors array", () => {
    expect(problemDetails({ status: 500, code: "internal", errors: [] }).errors).toBeUndefined();
  });

  it("allows a custom title override", () => {
    expect(problemDetails({ status: 500, code: "internal", title: "Boom" }).title).toBe("Boom");
  });
});

describe("problemResponse", () => {
  it("sets the problem+json content type and status, and serializes the body", async () => {
    const response = problemResponse({ status: 413, code: "payload_too_large" });
    expect(response.status).toBe(413);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
    const body = (await response.json()) as { code: string; status: number };
    expect(body.code).toBe("payload_too_large");
    expect(body.status).toBe(413);
  });

  it("merges caller headers (CORS / security baseline / auth challenge) without dropping them", () => {
    const response = problemResponse({
      status: 401,
      code: "unauthorized",
      headers: {
        "X-Frame-Options": "DENY",
        "WWW-Authenticate": 'Basic realm="Todoist Daily Agent", charset="UTF-8"',
      },
    });
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Basic realm="Todoist Daily Agent", charset="UTF-8"',
    );
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
  });
});

describe("zodIssuesToErrors", () => {
  const schema = z.object({
    input: z.object({ prompt: z.string().min(1, "Prompt is required") }),
    limits: z.object({ maxTasks: z.number().int().max(10, "Must be <= 10") }).optional(),
  });

  it("captures field-level messages that flatten().formErrors silently dropped", () => {
    const result = schema.safeParse({ input: { prompt: "" }, limits: { maxTasks: 99 } });
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const errors = zodIssuesToErrors(result.error);
    expect(errors).toContainEqual({ field: "input.prompt", message: "Prompt is required" });
    expect(errors).toContainEqual({ field: "limits.maxTasks", message: "Must be <= 10" });
    // Regression guard: the previous implementation joined formErrors, which is
    // empty for field-level issues, so these messages never reached the client.
    expect(result.error.flatten().formErrors).toEqual([]);
  });

  it("labels root-level issues distinctly", () => {
    const result = z.object({ a: z.string() }).safeParse("not-an-object");
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(zodIssuesToErrors(result.error)[0].field).toBe("(root)");
  });
});
