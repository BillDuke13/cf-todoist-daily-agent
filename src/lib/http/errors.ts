import type { ZodError } from "zod";

export type ErrorCode =
  | "validation_failed"
  | "unsupported_media_type"
  | "unauthorized"
  | "forbidden_origin"
  | "payload_too_large"
  | "rate_limited"
  | "misconfigured"
  | "ai_unavailable"
  | "todoist_unavailable"
  | "todoist_sync_failed"
  | "transcription_failed"
  | "internal";

export type FieldError = {
  field: string;
  message: string;
};

const DEFAULT_TITLES: Record<ErrorCode, string> = {
  validation_failed: "Invalid request",
  unsupported_media_type: "Unsupported media type",
  unauthorized: "Unauthorized",
  forbidden_origin: "Origin not allowed",
  payload_too_large: "Payload too large",
  rate_limited: "Too many requests",
  misconfigured: "Server misconfigured",
  ai_unavailable: "AI service unavailable",
  todoist_unavailable: "Todoist service unavailable",
  todoist_sync_failed: "Todoist sync failed",
  transcription_failed: "Transcription failed",
  internal: "Internal server error",
};

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  errors?: FieldError[];
};

type ProblemInit = {
  status: number;
  code: ErrorCode;
  detail?: string;
  errors?: FieldError[];
  title?: string;
};

export function problemDetails(init: ProblemInit): ProblemDetails {
  const problem: ProblemDetails = {
    type: `/errors/${init.code}`,
    title: init.title ?? DEFAULT_TITLES[init.code],
    status: init.status,
    code: init.code,
  };
  if (init.detail) {
    problem.detail = init.detail;
  }
  if (init.errors?.length) {
    problem.errors = init.errors;
  }
  return problem;
}

export function problemResponse(init: ProblemInit & { headers?: HeadersInit }): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/problem+json");
  return new Response(JSON.stringify(problemDetails(init)), {
    status: init.status,
    headers,
  });
}

export function zodIssuesToErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.length ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}
