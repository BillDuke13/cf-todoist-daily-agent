# Todoist Daily Agent Pipeline

This file is the AI-/developer-facing reference for how `/plan` and
`/api/transcribe` work. The human-facing overview lives in `docs/index.html`;
client and automation contracts live in `openapi/plan.yaml`. Keep all three
in sync when you touch the worker.

## Overview

- **Endpoint**: `POST /plan` (see `openapi/plan.yaml`). The handler lives at
  Next's `/api/plan`; `next.config.ts` rewrites `/plan` → `/api/plan` so
  browsers and worker-internal calls share one public URI.
- **Flow**: Single prompt dialog → Cloudflare Worker `/plan` → Workers AI
  intent pass (`@cf/openai/gpt-oss-120b`, reasoning effort **high**) →
  scenario-specific planning pass (`@cf/openai/gpt-oss-20b`, reasoning effort
  **medium**) → Todoist MCP Streamable HTTP (`https://ai.todoist.net/mcp`).
- **Response format**: `application/x-ndjson`; each line is one event of the
  versioned flat envelope below. The first line is always `stream.open`
  (carrying `protocol`); every event has a monotonic `seq` and an ISO-8601
  `ts`. Clients must tolerate unknown lines (in particular `debug.*` lines,
  which only appear when `DEBUG_EVENTS=true`).

## Input experience

- The landing page (`src/app/page.tsx`) renders one large dialog with a
  single textarea. The user describes their day in natural language; there
  is no manual task editor.
- The browser sends the grouped request body: the prompt as `input.prompt`,
  the auto-detected IANA timezone as `scheduling.timezone`, and
  `MAX_AUTOMATED_TASKS = 6` as `limits.maxTasks` (see "Request body" below).
- Helper copy reminds the operator that Todoist arguments (priority,
  project, labels, due fields) are inferred by the model from the prompt.
- The dedicated **Use voice input** button records up to 60 seconds of
  microphone audio (MediaRecorder, Opus/WebM), POSTs the base64 payload to
  `/api/transcribe`, and on success replaces the prompt and immediately
  submits `/plan`.

## Request body

`POST /plan` accepts a strict, intent-grouped JSON object (unknown keys are
rejected). Only `input.prompt` is required; the optional groups feed both the
AI prompt and the normalization fallbacks.

```json
{
  "input":      { "prompt": "Plan a calm evening", "preferences": "no screens after 9pm" },
  "scheduling": { "timezone": "America/New_York", "due": "today before 6pm" },
  "defaults":   { "priority": 3, "labels": ["evening"] },
  "limits":     { "maxTasks": 6 }
}
```

- `input.prompt` (1–8192) required; `input.preferences` (≤2048) optional.
- `scheduling.timezone` (IANA), `scheduling.due` (natural language) optional.
- `defaults.priority` (1–4), `defaults.labels` (≤5) optional.
- `limits.maxTasks` (1–10, default 5).
- The Worker requires `Content-Type: application/json` (`415` otherwise) and
  rejects bodies over 64KB before parsing (`413`).

## Intent-aware planning

1. **Intent classification** — The worker calls
   `@cf/openai/gpt-oss-120b` with reasoning effort `high` and a JSON-schema
   constraint. The model returns
   `{ intent, summary, days, keywords }` where
   `intent ∈ {single_reminder, multi_step_plan, recipe_plan, general_plan}`.
   A `plan.status` event with stage `intent.classified` is emitted, and the
   detected intent is later attached to the `plan.draft` event.
2. **Todoist metadata** — After connecting to the Todoist MCP server the
   worker calls `client.listTools()` and selects the appropriate listing
   tool based on, in order:
   - exact alias name (`todoist.projects.list`, `todoist.labels.list`, the
     legacy `todoist_projects` / `todoist_labels`),
   - exact name match for `find-projects` / `find-labels`,
   - keyword heuristic on the tool's name + description that filters out
     anything containing mutating verbs (`add`, `create`, `update`, ...).
   The collected projects/labels are then heuristically matched against the
   prompt to pick a default project and label set, and the catalog itself
   is injected into the planning prompt so the model emits valid project
   and label references.
3. **Scenario templates** (see `determineScenario()`):
   - `single_reminder` — exactly one task that mirrors the request literally.
   - `multi_step_plan` — at least two tasks with explicit sequencing or time
     anchors.
   - `recipe_plan` — meal-prep tasks across `days` (1–5), each task naming
     the day and meal slot.
   - `general_plan` — fallback: balanced schedule, no fabricated tasks.
4. **Task generation** — `@cf/openai/gpt-oss-20b` (reasoning effort
   `medium`) runs with the scenario directives, the metadata-aware prompt,
   and an explicit JSON schema (`planJsonSchema`). The worker then
   normalizes each task: priorities are clamped, labels are deduped against
   the live label catalog, projects are resolved to a known `id`, and due
   fields collapse to a single representation (`datetime` > `date` >
   `string` > input fallback).

### Priority cues

`detectPriorityFromPrompt()` looks for `P0`/`P1`/.../`P4`, `priority N`, or
`优先级 N`. Mapping (Todoist API direction):

| UI cue | API priority |
| --- | --- |
| `P0`, `P1` | `4` (highest) |
| `P2` | `3` |
| `P3` | `2` |
| `P4` (and unmatched) | `1` |

When the worker sends a payload to the bulk tool (`add-tasks`), the numeric
priority is converted back to the `p1`...`p4` string the new MCP schema
expects.

## Voice transcription endpoint

- **Endpoint**: `POST /api/transcribe` — internal helper used by the SPA,
  behind the same Basic Auth proxy in `src/proxy.ts`. There is no rewrite
  for this path; clients call it directly.
- **Body**:
  ```json
  {
    "audio": "<base64 encoded webm/opus audio>",
    "language": "optional language hint",
    "task": "transcribe|translate"
  }
  ```
- **Behavior**:
  - Rejects audio payloads that exceed ~8 MB after base64 decoding (HTTP
    `413`).
  - Calls `env.AI.run("@cf/openai/whisper-large-v3-turbo")` and returns
    `{ text, language? }`.
  - Errors are surfaced through the front-end UI without overwriting the
    existing prompt.

## Environment

| Variable | Purpose |
| --- | --- |
| `FRONTEND_ORIGIN` | Allowed browser origin(s) for CORS (comma-separated). |
| `TODOIST_MCP_URL` | Streamable HTTP endpoint, defaults to `https://ai.todoist.net/mcp`. |
| `TODOIST_TOKEN` | Bearer token recognized by Todoist MCP. |
| `BASIC_AUTH_USER` | Username for HTTP Basic Auth. |
| `BASIC_AUTH_PASS` | Password for HTTP Basic Auth. |
| `AUTH_REALM` | Basic Auth challenge realm. Non-sensitive `vars` default `"Todoist Daily Agent"`; override per environment. |
| `DEBUG_EVENTS` | `"true"` enables `debug.*` NDJSON events and truncated error detail. Defaults to `"false"` in `wrangler.jsonc#vars`. |
| `AI` binding | Workers AI binding declared in `wrangler.jsonc`. |

Local development uses `.dev.vars`; production secrets must be uploaded with
`wrangler secret put`.

## Error model

All HTTP error responses use RFC 9457 Problem Details
(`application/problem+json`):

```json
{
  "type": "/errors/validation_failed",
  "title": "Invalid request",
  "status": 400,
  "code": "validation_failed",
  "errors": [{ "field": "input.prompt", "message": "Prompt is required" }]
}
```

- `code` is the stable, machine-readable discriminator (shared with the
  stream's `plan.error.code` / `todoist.task.code`). The taxonomy lives in
  `src/lib/errors.ts`: `validation_failed`, `unsupported_media_type`,
  `unauthorized`, `forbidden_origin`, `payload_too_large`, `rate_limited`,
  `misconfigured`, `ai_unavailable`, `todoist_unavailable`,
  `todoist_sync_failed`, `transcription_failed`, `internal`.
- `validation_failed` (400) carries field-level `errors[]` with dotted paths
  (for example `input.prompt`). This replaces the previous opaque
  `{ "error": "Invalid request" }` body.

## Authentication

`src/proxy.ts` enforces HTTP Basic Auth (Web-Crypto SHA-256 constant-time
compare in `src/lib/auth.ts`) ahead of the route handlers, scoped by an
explicit matcher: `["/", "/plan", "/api/:path*"]` (static assets under
`/_next/*` stay public). The challenge realm is configurable via `AUTH_REALM`.
The proxy's `401`/`403`/`500` responses are problem+json. Brute-force
protection is delegated to the edge (Cloudflare WAF / Rate-Limiting rules on
`/plan` and `/api/*`) rather than in-worker state.

Every response (including the NDJSON stream) carries the hardened header
baseline from `src/lib/cors.ts#SECURITY_HEADERS`: HSTS, `nosniff`,
`X-Frame-Options: DENY`, a `Permissions-Policy`, and a defense-in-depth
`Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`,
`object-src 'none'`, `connect-src 'self'`). `script-`/`style-src` keep
`'unsafe-inline'` because Next.js injects inline bootstrap scripts and
`next/font` emits an inline `<style>`; a per-request nonce is the documented
follow-up. CORS reflects a single allow-listed `Access-Control-Allow-Origin`
(never `*`, validated by `resolveOrigin`) together with
`Access-Control-Allow-Credentials: true`, so a cross-origin `FRONTEND_ORIGIN`
can send Basic Auth credentials safely.

## MCP Contract

1. Open a `StreamableHTTPClientTransport` against `TODOIST_MCP_URL` with
   `Authorization: Bearer ${TODOIST_TOKEN}`.
2. `client.listTools()` should expose any of `create_task`, `add-task`,
   `add_task`, `create-task`, `add-tasks`, `add_tasks`. The worker walks the
   list in that exact preference order; whichever name matches first wins.
3. When the bulk variant (`add-tasks` / `add_tasks`) wins, payloads are
   wrapped as `{ tasks: [payload] }` and the priority is rendered as a
   `p1`...`p4` string. The single-task variant gets the numeric priority
   directly.
4. Each generated payload follows the public Todoist REST shape:
   `content`, `description`, `priority` / `p{1-4}`, `labels`, `dueString`,
   `dueDate`, `dueDatetime`, plus both `projectId` (camelCase) and
   `project_id` (snake_case) so legacy and official MCP servers both accept
   the request.
5. The worker streams MCP progress as `todoist.task` events with
   `status ∈ {pending, created, failed}`; a failed event carries a stable
   `code` (`todoist_sync_failed`) and, only under `DEBUG_EVENTS=true`, a raw
   `detail`. The `plan.final` event aggregates counts and the per-task results
   (each `TodoistTaskResult` mirrors that `code`; its `error` detail is
   likewise DEBUG-gated).

## Streaming Response Contract

- **Content-Type**: `application/x-ndjson`.
- **Envelope**: every event carries `type` (dotted `domain.event`), a monotonic
  `seq` (the leading `stream.open` is `seq: 0`), and an ISO-8601 `ts`.
  `protocol` (currently `"1.0"`) appears on `stream.open`.
- **Stable events** (always part of the contract):
  - `stream.open` — first line; announces `protocol` and echoes normalized
    request params (`request.maxTasks`). No sensitive fields.
  - `plan.status` — progress message; `stage ∈ {ai.init, intent.detect,
    intent.classified}` (closed set).
  - `plan.draft` — Workers AI output (planned `tasks`, optional `summary`,
    detected `intent`). Tasks may include `projectId` / `projectName` when a
    Todoist project matched.
  - `todoist.task` — one per MCP interaction (`pending`/`created`/`failed`).
    On `failed`, carries a stable `code`; the raw `detail` is omitted unless
    `DEBUG_EVENTS=true`.
  - `plan.final` — completion summary with counts and elapsed milliseconds.
  - `plan.error` — terminal failure with a stable `code` drawn from the
    `Problem` taxonomy: `ai_unavailable` (the planning model failed),
    `todoist_unavailable` (the MCP connection failed), or `internal` (anything
    else). `detail` is omitted unless `DEBUG_EVENTS=true`, so the production
    response stays opaque.
- **Debug events** (only when `DEBUG_EVENTS=true`, **not** part of the
  contract): `debug.tools`, `debug.metadata`, `debug.inference`,
  `debug.error`. Production clients must ignore unknown event types.
- Clients must parse line-by-line. `src/app/hooks/usePlanStream.ts` contains
  the reference NDJSON parser (`flushLines` + `enqueueEvent`).

## Observability & Debugging

- Tail logs (sanitization off) to inspect MCP traffic:
  ```bash
  WRANGLER_LOG_SANITIZE=false \
    npx wrangler tail cf-todoist-daily-agent --format json \
    > /tmp/wrangler-tail.log 2>&1 &
  ```
  Start the tail before triggering `/plan` so metadata events make it into
  the log.
- `[todoist.tools]` lists every MCP tool the worker can see; useful when a
  list/create call falls back to the keyword resolver.
- `[todoist.debug.metadata]` (debug event) shows the first projects /
  labels returned by Todoist — confirms the metadata catalog the model
  receives.
- `[todoist.debug.call-args]` (debug event) dumps the payload handed to
  `add-task(s)` (`project_id`, stringified priority `p1`...`p4`, due
  fields). Cross-check this against the Todoist Activity Log when tasks
  land in the wrong project / priority.

## Verification Steps

1. `pnpm lint` — ESLint flat config (Next 16 + React 19).
2. `pnpm test` — Vitest covering the pure helpers in `src/lib/`.
3. `pnpm exec tsc --noEmit` — TypeScript type check (depends on a
   materialized `cloudflare-env.d.ts`; `pnpm cf-typegen` regenerates it).
4. `pnpm preview` — full OpenNext build + Wrangler preview; required for
   real Workers AI / MCP traffic.
5. With `wrangler dev --local` and `.dev.vars` populated:
   ```bash
   curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
        -N -H "Content-Type: application/json" \
        -H "Origin: $FRONTEND_ORIGIN" \
        -d '{"input":{"prompt":"Plan a calm evening"}}' \
        http://127.0.0.1:8787/plan
   ```
   Confirm the first line is `stream.open`, that `seq` increases monotonically,
   and that Todoist MCP yields `todoist.task` `created` events ending in
   `plan.final`. Validation errors come back as `application/problem+json` with
   field-level `errors[]`; per-task failure detail is only inlined when
   `DEBUG_EVENTS=true`.
