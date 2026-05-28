# CLAUDE.md

This file gives Claude Code (claude.ai/code) the operating context it needs
when modifying this repository. Keep it short, factual, and anchored to the
current implementation.

## Build & Dev Commands

```bash
pnpm dev                # Next.js 16 dev server (Turbopack); no Workers AI bindings
pnpm lint               # ESLint flat config (Next + TS strict)
pnpm exec tsc --noEmit  # TypeScript type check
pnpm test               # Vitest run (CI mode)
pnpm test:watch         # Vitest watch mode
pnpm preview            # OpenNext build + Wrangler preview (required for Workers AI / MCP)
pnpm run deploy         # OpenNext build + `wrangler deploy`
pnpm run cf-typegen     # Regenerate cloudflare-env.d.ts from wrangler.jsonc
```

## Architecture

- **Runtime**: Next.js 16 (App Router) on Cloudflare Workers via the OpenNext
  adapter. The deployed entry point is `.open-next/worker.js`, declared in
  `wrangler.jsonc` (`compatibility_date: 2026-04-09`, flags `nodejs_compat`
  + `global_fetch_strictly_public`). Source code lives under `src/`.
- **Two-pass AI pipeline** (`src/app/api/plan/route.ts`):
  1. Intent classification with `@cf/openai/gpt-oss-120b`, reasoning effort
     `high`, JSON-schema constrained.
  2. Scenario-specific task planning with `@cf/openai/gpt-oss-20b`, reasoning
     effort `medium`, JSON-schema constrained.
- **Streaming response**: `application/x-ndjson`, a versioned flat envelope —
  every event carries a monotonic `seq` and an ISO-8601 `ts`. Stable types:
  `stream.open` (first line, carries `protocol`), `plan.status`, `plan.draft`,
  `todoist.task`, `plan.final`, `plan.error`. Anything beginning with `debug.`
  is gated by `DEBUG_EVENTS=true` and is **not** part of the public contract.
- **Todoist MCP integration**: `StreamableHTTPClientTransport` with dynamic
  tool discovery (`client.listTools()`) plus alias-based fallbacks, so the
  worker keeps working through Todoist tool renames or legacy/official
  divergence (`add-task`, `add-tasks`, `create_task`, ...).
- **Voice helper**: `POST /api/transcribe` proxies base64 WebM/Opus to
  `@cf/openai/whisper-large-v3-turbo` with an 8 MB decoded cap.
- **Auth**: HTTP Basic Auth in `src/proxy.ts` (the Next.js 16 successor to
  `middleware.ts`) using a Web-Crypto SHA-256 constant-time compare from
  `src/lib/auth.ts`. The matcher is an explicit allow-list
  (`["/", "/plan", "/api/:path*"]`); the realm is configurable via `AUTH_REALM`.
- **Errors**: all HTTP errors are RFC 9457 `application/problem+json` with a
  stable `code` (taxonomy + builders in `src/lib/errors.ts`), shared with the
  stream's `plan.error.code` / `todoist.task.code`. `validation_failed` carries
  field-level `errors[]`. Use `problemResponse()` / `zodIssuesToErrors()` — do
  not hand-roll error bodies or fall back to `formErrors`.
- **URL rewrite**: `next.config.ts` rewrites `/plan` → `/api/plan` so the
  SPA can POST to the short path. The transcription endpoint has no rewrite —
  clients call `/api/transcribe` directly.

## Required Environment Variables

Set in `.dev.vars` (local) or via `wrangler secret put` (production). Ambient
typings live in `src/types/cloudflare-secrets.d.ts`.

| Name | Purpose |
| --- | --- |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | HTTP Basic Auth credentials enforced by `src/proxy.ts`. |
| `AUTH_REALM` | Basic Auth challenge realm (non-sensitive `vars` default `"Todoist Daily Agent"`). |
| `TODOIST_TOKEN` | Bearer token for Todoist MCP. |
| `TODOIST_MCP_URL` | MCP endpoint (defaults to `https://ai.todoist.net/mcp`). |
| `FRONTEND_ORIGIN` | Allowed CORS origin; comma-separated list supported. |
| `DEBUG_EVENTS` | When `"true"` the worker emits `debug.*` NDJSON events and echoes truncated error detail to clients. Defaults to `"false"` in `wrangler.jsonc#vars`. |
| `AI` binding | Workers AI binding declared in `wrangler.jsonc`. |

## Code Conventions

- **Commits**: Conventional Commits (`feat(scope):`, `fix(scope):`, `docs:`, ...).
- **Path alias**: `@/*` → `./src/*`.
- **Strict TypeScript**: `strict: true` in `tsconfig.json`.
- **Zod validation**: All request bodies, AI responses, and intent payloads
  pass through Zod schemas before use.
- **Priority mapping**: Todoist REST priority is inverted — `4 = P1` (highest),
  `1 = P4` (lowest). Bulk MCP tools (`add-tasks`) expect string flags
  `p1`...`p4`; the single-task tool (`add-task` / `create_task`) expects the
  numeric form. `toTodoistArgs()` switches on `priorityStyle`.
- **Comments**: Default to none. Add a comment only when the WHY is
  non-obvious (security threat model, MCP field-name compatibility,
  webpack/runtime constraints, etc.). Do not describe WHAT — names should
  carry that.

## Gotchas

- `pnpm dev` cannot reach Workers AI models or Todoist MCP. Use `pnpm preview`
  (or `wrangler dev`) for full integration testing.
- `env.AI.run(...)` requires a `as unknown as { run: ... }` cast because the
  generated Workers AI types are still incomplete.
- `cloudflare-env.d.ts` is **not** committed; it is materialized by
  `pnpm cf-typegen` (wired into `postinstall`, `predev`, `prelint`,
  `pretest`, `prebuild`, `prepreview`, `predeploy`).
- Tests run with Vitest in a Node environment (`vitest.config.ts`). They
  cover the pure helpers (`src/lib/auth.ts`, `src/lib/cors.ts`,
  `src/lib/errors.ts`, `src/lib/priority.ts`); route handlers are exercised
  via `pnpm preview` and live MCP traffic.
- `wrangler.jsonc#vars.DEBUG_EVENTS` is typed as the literal `"false"` by
  `cf-typegen`; `isDebugEnabled` casts through `unknown` so a
  `wrangler secret put DEBUG_EVENTS true` override stays comparable at
  runtime. Do not "fix" the cast.

## Key Documentation

- @docs/PLAN_PIPELINE.md — pipeline architecture, MCP contract, debug events.
- @docs/index.html — human-facing product overview (rendered HTML).
- @openapi/plan.yaml — OpenAPI 3.1.0 spec for `/plan` and `/api/transcribe`.
