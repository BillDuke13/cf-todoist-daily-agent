# Todoist Daily Planner (`cf-todoist-daily-agent`)

Next.js 16 application deployed on Cloudflare Workers via OpenNext. It converts a natural-language text or voice prompt into structured Todoist tasks using Workers AI, streams progress over NDJSON, and creates tasks through the Todoist Model Context Protocol (MCP) Streamable HTTP endpoint.

Licensed under Apache 2.0 ([LICENSE](LICENSE)).

## Documentation

- [docs/pipeline.md](docs/pipeline.md) — planning pipeline, intent scenarios, Todoist MCP resolution, NDJSON protocol, and security headers.
- [openapi/plan.yaml](openapi/plan.yaml) — OpenAPI 3.1.0 specification for `/plan` and `/api/transcribe`.

## Architecture

- **Frontend (`src/app/`, `src/components/`, `src/hooks/`)**: Single-page React 19 client that submits prompts to `POST /plan`, renders streamed NDJSON updates, and optionally records audio via MediaRecorder for `POST /api/transcribe`.
- **Planning API (`src/app/api/plan/route.ts`, `src/lib/plan/`)**: Validates grouped JSON requests with Zod, runs intent classification (`@cf/openai/gpt-oss-120b`) and task generation (`@cf/openai/gpt-oss-20b`), normalizes tasks against live Todoist metadata, and streams `application/x-ndjson`.
- **Todoist MCP (`src/lib/todoist/`)**: Connects over `StreamableHTTPClientTransport`, resolves project/label listing and task-creation tools dynamically, normalizes Todoist priority inversions (`4 = P1` through `1 = P4`), and syncs each task.
- **Voice transcription (`src/app/api/transcribe/route.ts`)**: Forwards base64 WebM/Opus clips (up to 8 MB decoded) to `@cf/openai/whisper-large-v3-turbo`.
- **Auth & errors (`src/proxy.ts`, `src/lib/http/`)**: Enforces HTTP Basic Auth with SHA-256 constant-time comparison on `["/", "/plan", "/api/:path*"]`, applies strict CORS and security headers, and returns RFC 9457 `application/problem+json` errors.

## Prerequisites

- Node.js 22.12+
- `pnpm` 12+
- Cloudflare account with Workers AI enabled
- Todoist API token with access to `https://ai.todoist.net/mcp`

## Configuration

Put local secrets in `.dev.vars` at the repository root and upload production secrets with `wrangler secret put`. Non-sensitive defaults live in `wrangler.jsonc#vars`; secret typings live in `src/types/cloudflare-secrets.d.ts`.

| Name | Source | Description |
| --- | --- | --- |
| `FRONTEND_ORIGIN` | Secret | Allowed browser origin(s) for CORS (comma-separated). |
| `TODOIST_MCP_URL` | Secret | Todoist MCP Streamable HTTP endpoint (typically `https://ai.todoist.net/mcp`). |
| `TODOIST_TOKEN` | Secret | Bearer token for Todoist MCP. |
| `BASIC_AUTH_USER` | Secret | HTTP Basic Auth username enforced by `src/proxy.ts`. |
| `BASIC_AUTH_PASS` | Secret | HTTP Basic Auth password enforced by `src/proxy.ts`. |
| `AUTH_REALM` | `wrangler.jsonc` var | HTTP Basic Auth challenge realm (default `"Todoist Daily Agent"`). |
| `DEBUG_EVENTS` | `wrangler.jsonc` var / Secret override | Set to `"true"` to emit `debug.*` NDJSON frames and raw error details (default `"false"`). |
| `AI` | `wrangler.jsonc` binding | Cloudflare Workers AI binding. |

## Development

```bash
pnpm install
pnpm dev            # Next.js dev server (Turbopack; no live Workers AI or MCP bindings)
pnpm lint           # ESLint flat config (Next.js core-web-vitals + TypeScript)
pnpm typecheck      # TypeScript check (runs cf-typegen first)
pnpm test           # Vitest single run
pnpm test:watch     # Vitest watch mode
pnpm build          # Production Next.js build (webpack)
pnpm preview        # OpenNext Cloudflare build + local Wrangler preview
```

Example streaming request against a local Worker (`pnpm preview` or `wrangler dev`):

```bash
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  -N \
  -H "Content-Type: application/json" \
  -H "Origin: $FRONTEND_ORIGIN" \
  -d '{"input":{"prompt":"Plan a focused work morning"}}' \
  http://127.0.0.1:8787/plan
```

## Generated Cloudflare Types

`cloudflare-env.d.ts` is generated from `wrangler.jsonc` via `pnpm cf-typegen` and is not committed. Lifecycle hooks run `cf-typegen` automatically on `install`, `dev`, `lint`, `typecheck`, `test`, `build`, `preview`, and `deploy`. If you install with `--ignore-scripts`, run `pnpm cf-typegen` explicitly before typechecking or building.

## Deployment

```bash
pnpm run deploy
```

Builds `.open-next/worker.js` and static assets via OpenNext and deploys to the Worker defined in `wrangler.jsonc`.

## Debugging Production Traffic

1. Stream unsanitized Worker logs:
   ```bash
   WRANGLER_LOG_SANITIZE=false pnpm exec wrangler tail cf-todoist-daily-agent --format json
   ```
2. Temporarily enable `DEBUG_EVENTS=true` via `.dev.vars` or `wrangler secret put DEBUG_EVENTS` to include `debug.tools`, `debug.metadata`, `debug.inference`, and `debug.error` frames in the NDJSON response.
3. Inspect `[todoist.tools]` in logs to verify which MCP tools were discovered.

## API Summary

- `OPTIONS /plan` — CORS preflight (`204`).
- `POST /plan` — Rewritten to `/api/plan`; streams `application/x-ndjson` events (`stream.open`, `plan.status`, `plan.draft`, `todoist.task`, `plan.final`, `plan.error`).
- `OPTIONS /api/transcribe` — CORS preflight (`204`).
- `POST /api/transcribe` — Accepts base64 audio JSON and returns `{ text, language? }`.

All HTTP error responses use RFC 9457 `application/problem+json` with a stable `code` field (see [openapi/plan.yaml](openapi/plan.yaml)).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
