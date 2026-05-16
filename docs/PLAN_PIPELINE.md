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
- **Response format**: `application/x-ndjson`; each line is one of the
  events listed below. Clients must tolerate unknown lines (in particular
  `debug.*` lines, which only appear when `DEBUG_EVENTS=true`).

## Input experience

- The landing page (`src/app/page.tsx`) renders one large dialog with a
  single textarea. The user describes their day in natural language; there
  is no manual task editor.
- The browser auto-detects its IANA timezone and ships it with every
  request. `MAX_AUTOMATED_TASKS = 6` is the cap the SPA sends as `maxTasks`.
- Helper copy reminds the operator that Todoist arguments (priority,
  project, labels, due fields) are inferred by the model from the prompt.
- The dedicated **Use voice input** button records up to 60 seconds of
  microphone audio (MediaRecorder, Opus/WebM), POSTs the base64 payload to
  `/api/transcribe`, and on success replaces the prompt and immediately
  submits `/plan`.

## Intent-aware planning

1. **Intent classification** — The worker calls
   `@cf/openai/gpt-oss-120b` with reasoning effort `high` and a JSON-schema
   constraint. The model returns
   `{ intent, summary, days, keywords }` where
   `intent ∈ {single_reminder, multi_step_plan, recipe_plan, general_plan}`.
   A `status` event with stage `intent:classified` is emitted, and the
   detected intent is later attached to the `ai.plan` event.
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
| `DEBUG_EVENTS` | `"true"` enables `debug.*` NDJSON events and truncated error detail. Defaults to `"false"` in `wrangler.jsonc#vars`. |
| `AI` binding | Workers AI binding declared in `wrangler.jsonc`. |

Local development uses `.dev.vars`; production secrets must be uploaded with
`wrangler secret put`.

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
   `status ∈ {pending, created, failed}`. The `final` event aggregates
   counts and the per-task results.

## Streaming Response Contract

- **Content-Type**: `application/x-ndjson`.
- **Stable events** (always part of the contract):
  - `status` — descriptive message for AI / MCP stages.
  - `ai.plan` — Workers AI output (planned tasks, optional summary, detected
    `intent`). Tasks may include `projectId` / `projectName` when a Todoist
    project matched.
  - `todoist.task` — one per MCP interaction (`pending`/`created`/`failed`).
  - `final` — completion summary with counts and elapsed milliseconds.
  - `error` — terminal failure. `detail` is omitted unless
    `DEBUG_EVENTS=true`, so the production response stays opaque.
- **Debug events** (only when `DEBUG_EVENTS=true`, **not** part of the
  contract): `debug.tools`, `debug.metadata`, `debug.inference`,
  `debug.error`. Production clients must ignore unknown event types.
- Clients must parse line-by-line. `src/app/page.tsx` contains a reference
  NDJSON parser (`flushLines` + `enqueueEvent`).

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
        -d '{"prompt":"Plan a calm evening"}' \
        http://127.0.0.1:8787/plan
   ```
   Confirm Todoist MCP returns `created` events; failures inline the MCP
   error text.
