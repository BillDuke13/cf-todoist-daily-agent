# Todoist Daily Agent

A Cloudflare Worker + Next.js 16 reference implementation that plans a focused
day with Workers AI, streams the intermediate events to the browser, and
syncs the resulting tasks into Todoist through the official Model Context
Protocol (MCP) Streamable HTTP endpoint. Distributed under the Apache 2.0
License (see [LICENSE](LICENSE)).

> **Looking for a product overview?** Open [`docs/index.html`](docs/index.html)
> in a browser for a human-friendly walkthrough. The technical references
> live in [`docs/PLAN_PIPELINE.md`](docs/PLAN_PIPELINE.md) and
> [`openapi/plan.yaml`](openapi/plan.yaml).

## Architecture Overview

- **Frontend**: React 19 App Router page (`src/app/page.tsx`) that captures
  a single natural-language prompt, streams NDJSON events from `/plan`, and
  optionally records a short voice note that flows through `/api/transcribe`.
- **Planning pipeline**: `/plan` validates the request, runs intent
  classification (`@cf/openai/gpt-oss-120b`, reasoning effort `high`)
  followed by scenario-specific planning (`@cf/openai/gpt-oss-20b`,
  reasoning effort `medium`), discovers Todoist projects/labels dynamically,
  and streams every stage as newline-delimited JSON. Details live in
  [`docs/PLAN_PIPELINE.md`](docs/PLAN_PIPELINE.md).
- **Todoist MCP integration**: Uses `StreamableHTTPClientTransport` to
  connect to `https://ai.todoist.net/mcp`, lists whatever metadata/tools the
  server exposes (legacy or official aliases), and calls `add-task(s)` with
  both `projectId` and `project_id` fields plus normalized priorities
  (numeric `1-4` or `p1`…`p4` flags depending on the variant in use).
- **Voice transcription**: `/api/transcribe` proxies base64 WebM/Opus audio
  to `@cf/openai/whisper-large-v3-turbo`, enforcing an 8 MB decoded cap so
  the front-end can overwrite the prompt and immediately submit `/plan`.
- **Auth**: HTTP Basic Auth in `src/proxy.ts` (the Next.js 16 successor to
  `middleware.ts`) using a Web-Crypto SHA-256 constant-time compare from
  `src/lib/auth.ts`, scoped by an explicit matcher
  (`["/", "/plan", "/api/:path*"]`) with a configurable `AUTH_REALM`. All HTTP
  errors are RFC 9457 `application/problem+json` (taxonomy in
  `src/lib/errors.ts`).

## Features

- **Intent-aware planning**: `single_reminder`, `multi_step_plan`,
  `recipe_plan`, and `general_plan` templates enforce task counts,
  dependencies, and tone.
- **Metadata-driven prompts**: Todoist projects/labels fetched via MCP are
  injected into the AI prompt and exposed through `debug.metadata` events
  so tasks rarely fall back to "Inbox".
- **Priority normalization**: Natural-language cues such as `P0`, `P1`,
  `优先级 2`, or "high priority" map to Todoist REST priority numbers
  (`4 = P1`, `1 = P4`). Bulk MCP tools receive `p1`…`p4` strings instead.
- **Streaming UX**: `/plan` replies with `application/x-ndjson` — a versioned
  flat envelope (`stream.open`, `plan.status`, `plan.draft`, `todoist.task`,
  `plan.final`, `plan.error`; every event has `seq` + `ts`) so the UI can
  display progress and failures incrementally.
- **Voice-first flow**: Browser MediaRecorder → `/api/transcribe` → prompt
  submission in one click, with graceful fallbacks when permissions or size
  limits fail.

## Prerequisites

- Node.js 20+
- `pnpm` 9+
- Wrangler CLI 4.45+
- Cloudflare account with Workers AI enabled
- Todoist account + API token approved for the MCP beta
  (`https://ai.todoist.net/mcp`)

## Configuration

| Name | Description |
| --- | --- |
| `FRONTEND_ORIGIN` | Allowed browser origin for CORS and Basic Auth prompts. Comma-separated list supported (e.g. `https://staging.example.com,https://app.example.com`). |
| `TODOIST_MCP_URL` | MCP Streamable HTTP endpoint (default `https://ai.todoist.net/mcp`). |
| `TODOIST_TOKEN` | Bearer token recognized by Todoist MCP. |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | Credentials enforced by `src/proxy.ts` for every authenticated route (`/plan`, `/api/transcribe`, page routes). |
| `AUTH_REALM` | Optional Basic Auth challenge realm. Non-sensitive `vars` default `"Todoist Daily Agent"`; override per environment. |
| `DEBUG_EVENTS` | When `"true"` the worker emits `debug.*` NDJSON events and echoes truncated error detail to clients. Defaults to `"false"` in `wrangler.jsonc#vars`. |
| `AI` binding | Configured in `wrangler.jsonc` to access Workers AI. |

Populate `.dev.vars` for local runs, then mirror the same names in
Cloudflare via `wrangler secret put`. Ambient typings for these secrets
live in `src/types/cloudflare-secrets.d.ts`.

## Local Development

```bash
pnpm install
pnpm dev          # Next.js dev server (no Worker bindings, no Workers AI)
pnpm lint         # ESLint flat config (Next 16 + TS strict)
pnpm test         # Vitest run (pure helpers in src/lib)
pnpm test:watch   # Vitest watch mode
pnpm preview      # OpenNext build + Wrangler preview (full integration)
wrangler dev      # Run the Worker locally at http://127.0.0.1:8787
```

Example streaming request:

```bash
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
     -N -H "Content-Type: application/json" \
     -H "Origin: $FRONTEND_ORIGIN" \
     -d '{"input":{"prompt":"Plan a mindful evening"}}' \
     http://127.0.0.1:8787/plan
```

## Generated Types

`cloudflare-env.d.ts` is produced by `wrangler types` from `wrangler.jsonc`
and is intentionally **not committed**. Package scripts wire `pnpm cf-typegen`
into every common entry point, so a normal `pnpm install` followed by any of
`pnpm dev`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm preview`, or
`pnpm run deploy` materializes the file for you:

| Trigger | Hook |
| --- | --- |
| `pnpm install` | `postinstall` |
| `pnpm dev` | `predev` |
| `pnpm lint` | `prelint` |
| `pnpm test` | `pretest` |
| `pnpm build` | `prebuild` |
| `pnpm preview` | `prepreview` |
| `pnpm run deploy` | `predeploy` |

If you bypass scripts — for example `pnpm install --ignore-scripts` in a CI
image, or a Docker build that skips `devDependencies` (so `wrangler` is
absent) — `cloudflare-env.d.ts` will be missing and `pnpm exec tsc --noEmit`
(which has no wrapper) will surface precise
`Property '<NAME>' does not exist on type 'CloudflareEnv'` errors. Run
`pnpm cf-typegen` once to fix it. The opaque
`TS2688: Cannot find type definition file` was retired so missing-types
failures are now actionable.

For Docker `--prod` images, either keep `wrangler` available during the
build (so `postinstall` succeeds) or pass `pnpm install --ignore-scripts`
and run `pnpm cf-typegen` explicitly in a stage that has `wrangler`.

## Deployment

```bash
pnpm run deploy   # opennextjs-cloudflare build && opennextjs-cloudflare deploy
```

The script produces `.open-next/worker.js`, uploads static assets, and
publishes to the Worker name in `wrangler.jsonc`.

## Observability & Debugging

1. Tail logs with sanitization disabled to capture Todoist payloads:
   ```bash
   LOG_FILE=$(mktemp -t wrangler-tail).log
   WRANGLER_LOG_SANITIZE=false npx wrangler tail cf-todoist-daily-agent \
     --format json > "$LOG_FILE" 2>&1 &
   ```
2. Set `DEBUG_EVENTS=true` (locally in `.dev.vars` or via
   `wrangler secret put`) so the NDJSON stream surfaces `debug.tools`,
   `debug.metadata`, `debug.inference`, and `debug.error` lines.
3. Trigger `/plan` while the tail is running. Cross-reference:
   - `[todoist.tools]` — every MCP tool the worker can see.
   - `[todoist.debug.metadata]` — first projects/labels (confirms metadata
     scope).
   - `[todoist.debug.call-args]` — exact `add-task(s)` payload (check
     `project_id`, `priority`, `due*`).
4. Compare against the Todoist Activity Log to confirm tasks landed in the
   expected project and priority.

## API Summary

- `OPTIONS /plan` — CORS preflight (`204`).
- `POST /plan` — Main planner endpoint returning `application/x-ndjson`
  (see [`openapi/plan.yaml`](openapi/plan.yaml)).
- `OPTIONS /api/transcribe` — CORS preflight (`204`).
- `POST /api/transcribe` — Voice helper, returns `{ text, language? }` on
  success; errors are `application/problem+json`.

Request bodies are grouped objects (`/plan` takes `input` / `scheduling` /
`defaults` / `limits`). All error responses use RFC 9457
`application/problem+json` with a stable `code`; `validation_failed` carries
field-level `errors[]`. The OpenAPI document defines request/response shapes
for automation and client generation. `debug.*` events are intentionally
**not** part of the stable contract.

## Testing & Verification

- `pnpm lint`
- `pnpm test`
- `pnpm exec tsc --noEmit`
- `pnpm preview`
- `wrangler dev --local` followed by the sample curl above to validate
  NDJSON streaming and Todoist MCP connectivity.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
