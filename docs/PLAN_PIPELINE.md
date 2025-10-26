<!-- Related Serena Memory: features/plan-mcp-upgrade/IMPLEMENTATION.md -->
<!-- Last Synced: 2025-10-26 -->

# Todoist Daily Agent Pipeline

## Overview
- **Endpoint**: `POST /plan` (see `openapi/plan.yaml`). Internally the handler lives at Next's `/api/plan`; `next.config.ts` rewrites `/plan` → `/api/plan` so browsers and Workers share a single public URI.
- **Flow**: Single prompt dialog → Cloudflare Worker `/plan` → Workers AI intent pass (`@cf/openai/gpt-oss-120b`, reasoning effort **high**) → scenario-specific planning pass (`@cf/openai/gpt-oss-20b`, reasoning effort **medium**) → Todoist MCP Streamable HTTP (`https://ai.todoist.net/mcp`).
- **Response format**: `application/x-ndjson`; each line is a JSON event describing planning, detected intent, MCP calls, or failures.

## Input experience
- The landing page renders a single large dialog (see `src/app/page.tsx`) with one textarea. Users describe their day in natural language; no manual task table editing is needed.
- The browser auto-detects the timezone and includes it in every request along with a fixed `maxTasks` (currently 6). The Worker prompt tells the model to infer Todoist task names, sections/projects, priorities, due windows, and labels directly from the text.
- Helper copy beside the textarea reminds operators that MCP parameters are filled automatically, reducing misalignment between UI inputs and the schema enforced in `src/app/api/plan/route.ts`.
- A dedicated **Use voice input** button sits under the dialog. When pressed it records up to 60 seconds of audio (MediaRecorder Opus/WebM), posts the base64 payload to `/api/transcribe`, and streams it through `@cf/openai/whisper-large-v3-turbo`. Successful transcripts overwrite the prompt and immediately submit `/plan`.

## Intent-aware planning
1. **Intent classification**: `/plan` first calls `@cf/openai/gpt-oss-120b` with reasoning effort `high`. The model emits JSON `{ intent, summary, days, keywords }`, where `intent ∈ {single_reminder, multi_step_plan, recipe_plan, general_plan}`. The Worker emits a `status` event (`intent:classified`) plus includes the detected intent in later `ai.plan` events for observability.
2. **Todoist metadata**: After connecting to the Todoist MCP server, the Worker inspects `client.listTools()` and calls whichever metadata tools are available (for example, `todoist.projects.list`, `todoist.labels.list`, or the legacy `todoist_projects`/`todoist_labels` pair). It then builds a live catalog of project IDs and label names, heuristically infers which project/labels the user referenced (for example, “put this task under Home project”), and exposes that as default guidance. This metadata is injected into the planning prompt so the model can assign `projectId`/label fields that actually exist (if metadata is unavailable, tasks fall back to the Inbox with no labels).
3. **Scenario templates**:
   - `single_reminder`: forces a single Todoist task that mirrors the user’s wording (no routines).
   - `multi_step_plan`: produces ≥2 steps with time anchors or dependencies.
   - `recipe_plan`: generates meal tasks per day, referencing provided ingredients.
   - `general_plan`: fallback behaviour similar to the previous implementation.
4. **Task generation**: Based on the scenario, the Worker calls `@cf/openai/gpt-oss-20b` (reasoning effort `medium`) with a tailored prompt segment, max-task cap, and JSON schema constraint. The Worker also passes along any explicit priority hints (for example `P0/P1` map to Todoist priority `4`, `P2` → `3`, `P3` → `2`, everything else → `1`). The result flows through the normalization + Todoist MCP sync, which now sets `project_id` whenever a valid project match was found.

## Voice transcription endpoint
- **Endpoint**: `POST /transcribe` (internal helper used by the SPA; protected by the same Basic Auth middleware).
- **Body**:
  ```json
  {
    "audio": "<base64 encoded webm/opus audio>",
    "language": "optional lang hint",
    "task": "transcribe|translate"
  }
  ```
- **Behavior**:
  - Rejects audio payloads larger than ~8MB decoded.
  - Calls `env.AI.run("@cf/openai/whisper-large-v3-turbo")` and returns `{ "text": "..." }`.
  - Errors bubble to the client UI, keeping the existing prompt untouched.

## Environment
| Variable | Description |
| --- | --- |
| `FRONTEND_ORIGIN` | Allowed browser origin for CORS checks (single value). |
| `TODOIST_MCP_URL` | Streamable HTTP endpoint, defaults to `https://ai.todoist.net/mcp`. |
| `TODOIST_TOKEN` | Bearer token recognized by Todoist MCP. |
| `BASIC_AUTH_USER` | Username for HTTP Basic Auth. |
| `BASIC_AUTH_PASS` | Password for HTTP Basic Auth. |
| `AI` binding | Configured in `wrangler.jsonc` to access Workers AI (`binding: "AI"`). |

Local development uses `.dev.vars` to seed the same names; production secrets must be stored via `wrangler secret put`.

## MCP Contract
1. Create a `StreamableHTTPClientTransport` with `Authorization: Bearer {TODOIST_TOKEN}` headers.
2. `Client.listTools()` should expose `create_task`, `add-task`, or `add-tasks`; fallback order is `create_task → add-task → add_task → create-task → add-tasks → add_tasks`. When Todoist returns the bulk `add-tasks` tool, the Worker wraps each payload in `{ tasks: [...] }` and converts the priority into the `p1`...`p4` strings required by the new schema.
3. Each generated Todoist payload aligns with the public Todoist REST fields: `content`, `description`, `priority`/`p{1-4}`, `labels`, `dueString`/`dueDate`/`dueDatetime`.
4. The Worker surfaces MCP progress through events:
   - `todoist.task` (pending/created/failed) per tool call.
   - `final` event summarizing counts and echoing the MCP responses for audit.

## Streaming Response Contract
- **Content-Type**: `application/x-ndjson`.
- **Events**:
  - `status`: descriptive message for AI/MCP stages.
  - `ai.plan`: Workers AI output (planned tasks + optional summary) and the selected `intent`. Each task may include `projectId`/`projectName` when the model matched one of the fetched Todoist projects.
  - `todoist.task`: one per MCP interaction.
  - `error`: terminal failure.
  - `final`: completion summary with elapsed milliseconds.
- Clients must parse line-by-line; see `src/app/page.tsx` for a reference NDJSON parser.

## Observability & Debugging
- Use `WRANGLER_LOG_SANITIZE=false npx wrangler tail cf-todoist-daily-agent --format json > /tmp/wrangler-tail.log 2>&1 &` to capture live MCP diagnostics without redacted payloads. Always start the tail before triggering `/plan` so metadata events are included.
- `[todoist.debug.metadata]` captures the first few projects/labels returned by Todoist, making it easy to confirm that the Worker received the right catalog.
- `[todoist.debug.call-args]` dumps the payload handed to `add-task(s)` including `project_id`, stringified priorities (`p1`…`p4`), and due strings. Use this to reconcile with the Todoist Activity Log when tasks land in the wrong Inbox/priority.

## Verification Steps
1. `pnpm lint` – ESLint flat config covering Next 16 + React 19.
2. `pnpm preview` – builds via OpenNext and launches Wrangler preview (requires `FRONTEND_ORIGIN` etc.).
3. `wrangler dev --local` – run the Worker locally (export `BASIC_AUTH_USER/PASS` in `.dev.vars`), then:
   ```bash
   curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
        -N -H "Content-Type: application/json" \
        -H "Origin: $FRONTEND_ORIGIN" \
        -d '{"prompt":"Plan a calm evening"}' \
        http://127.0.0.1:8787/plan
   ```
4. Confirm Todoist MCP returns `created` events. Failures should include the MCP error text in-line.
