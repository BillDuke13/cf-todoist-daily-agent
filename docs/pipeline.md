# Planning Pipeline Reference

Technical overview of `/plan` and `/api/transcribe`. For setup, environment variables, and CLI commands, see [README.md](../README.md). For formal request, response, and error schemas, see [openapi/plan.yaml](../openapi/plan.yaml).

## Request Flow

1. `src/proxy.ts` validates HTTP Basic Auth on `["/", "/plan", "/api/:path*"]` (bypassing auth on `OPTIONS` after checking `Origin` against `FRONTEND_ORIGIN`) and attaches security headers.
2. `next.config.ts` rewrites `/plan` to `/api/plan`.
3. `POST /api/plan` validates `Origin`, `Content-Type: application/json` (`415`), `Content-Length <= 64 KB` (`413`), and the strict Zod request schema (`400` with field-level `errors[]`).
4. The route opens an `application/x-ndjson` stream (`src/lib/plan/stream.ts`) that checks abort/cancel signals before each external call and frames every event with a monotonic `seq` (starting at `0`) and ISO-8601 `ts`.

## Planning Stages

### 1. Todoist MCP connection and tool discovery (`src/lib/todoist/`)

When `TODOIST_MCP_URL` and `TODOIST_TOKEN` are configured, the worker connects via `StreamableHTTPClientTransport` and calls `client.listTools()`.

Project and label listing tools are resolved in order:
- Known aliases (`todoist_projects`, `todoist.projects.list`, `todoist_labels`, `todoist.labels.list`).
- Official names (`find-projects`, `find-labels`).
- Keyword match on tool name and description containing a read verb (`list`, `find`, `search`, `get`, `overview`, `browse`, `view`, `all`) and excluding mutating verbs (`add`, `create`, `update`, `delete`, `remove`, `complete`, `close`, `assign`, `set`, `comment`).

### 2. Intent classification (`src/lib/plan/intent.ts`)

`@cf/openai/gpt-oss-120b` (`reasoning.effort = "high"`, JSON-schema constrained) classifies the request into one of four scenarios:

| Intent | Task cap (`determineScenario`) | Behavior |
| --- | --- | --- |
| `single_reminder` | `1` | Keeps one literal reminder task without expanding extra routines. |
| `multi_step_plan` | `clamp(max(2, maxTasks), 1, 10)` | Ordered steps with explicit sequencing or time anchors. |
| `recipe_plan` | `clamp(clamp(days ?? 3, 1, 5) * 2, 1, 10)` | Meal tasks naming day, meal slot, and ingredients. |
| `general_plan` | `clamp(maxTasks, 1, 10)` | Balanced schedule matching prompt scope (also fallback on classification errors). |

### 3. Task generation and normalization (`src/lib/plan/prompt.ts`, `src/lib/plan/normalize.ts`)

Live Todoist projects and labels are matched heuristically against the prompt and injected into the prompt context. `@cf/openai/gpt-oss-20b` (`reasoning.effort = "medium"`, JSON-schema constrained) generates structured tasks.

Post-generation normalization:
- Trims titles and descriptions.
- Resolves priority with precedence `task.priority ?? promptHint ?? request.defaults.priority`, clamped to `[1, 4]`.
- Canonicalizes labels against the live catalog, deduplicates case-insensitively, and caps at 5 labels.
- Resolves project references by ID, exact case-insensitive name match, or prompt-inferred non-Inbox project.
- Selects a single due representation in order: `datetime` > `date` > `string` > `scheduling.due`.

### Priority mapping (`src/lib/todoist/priority.ts`)

Todoist REST priorities are inverted relative to UI labels:

| Prompt / UI label | Todoist API integer | Bulk MCP string flag |
| --- | --- | --- |
| `P0`, `P1` | `4` (highest) | `p1` |
| `P2` | `3` | `p2` |
| `P3` | `2` | `p3` |
| `P4` | `1` (lowest) | `p4` |

`detectPriorityFromPrompt()` recognizes `P0`-`P4`, `priority N`, and `优先级 N`.

### 4. Todoist synchronization (`src/lib/todoist/mcp-client.ts`)

Create-task tools are selected by preference order:
`create_task` -> `add-task` -> `add_task` -> `create-task` -> `add-tasks` -> `add_tasks`.

- Bulk variants (`add-tasks`, `add_tasks`) wrap each payload as `{ tasks: [payload] }` and send string priority flags (`p1`-`p4`).
- Single-task variants send numeric priority (`1`-`4`).
- Both `projectId` and `project_id` are sent when a project ID is resolved for compatibility across MCP server variants.

## NDJSON Stream Contract (`src/lib/plan/contract.ts`)

Every line is a JSON object carrying `type`, `seq`, and `ts`. Clients must ignore unknown types.

- `stream.open` (`seq: 0`): announces `protocol: "1.0"` and normalized `request.maxTasks`.
- `plan.status`: progress stage (`ai.init`, `intent.detect`, `intent.classified`) and message.
- `plan.draft`: normalized `tasks`, optional `summary`, and detected `intent`.
- `todoist.task`: per-task sync status (`pending`, `created`, `failed`), optional `todoistId`, and `code` on failure.
- `plan.final`: totals (`created`, `failed`), `elapsedMs`, and per-task result array.
- `plan.error`: terminal stream failure with stable `code` (`ai_unavailable`, `todoist_unavailable`, `internal`) and generic `message`.

When `DEBUG_EVENTS=true`, the stream also emits `debug.tools`, `debug.metadata`, `debug.inference`, and `debug.error`, and populates truncated raw failure details (`detail` / `error`). These are excluded from the stable contract.

## Voice Transcription (`src/app/api/transcribe/route.ts`)

The UI's **Use voice** button (`src/hooks/useVoiceCapture.ts`) records up to 60 seconds of WebM/Opus audio, encodes it to base64, and sends `POST /api/transcribe`.

- Enforces `Content-Type: application/json`, pre-parse `Content-Length` cap, and an 8 MB decoded audio limit (`413`).
- Calls `@cf/openai/whisper-large-v3-turbo` and returns `{ text, language? }`.
- On success, the client populates the prompt field and submits `/plan`.

## Error Model and Security Headers (`src/lib/http/`)

- All HTTP error responses return RFC 9457 `application/problem+json` with a stable `code` from `ErrorCode` (`src/lib/http/errors.ts`).
- `SECURITY_HEADERS` (`src/lib/http/cors.ts`) applies HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (same-origin `microphone=(self)`), and `Content-Security-Policy`.
- Production CSP omits `'unsafe-eval'` and `ws:`; development mode enables both for Next.js HMR. `script-src` and `style-src` retain `'unsafe-inline'` for Next.js inline bootstrap scripts and `next/font` styles.
- CORS reflects only a single allow-listed origin alongside `Access-Control-Allow-Credentials: true`.
