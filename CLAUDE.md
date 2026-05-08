# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
pnpm dev              # Next.js dev server (Turbopack) — no Workers AI locally
pnpm lint             # ESLint (flat config)
pnpm exec tsc --noEmit  # Type check
pnpm preview          # Full build + local Cloudflare preview (required for AI model testing)
pnpm run deploy       # Build + deploy to Cloudflare Workers
pnpm run cf-typegen   # Regenerate cloudflare-env.d.ts from wrangler.jsonc bindings
```

## Architecture

- **Runtime**: Next.js 16 App Router on Cloudflare Workers via OpenNext adapter
- **Build output**: `.open-next/worker.js` (entry point referenced in `wrangler.jsonc`) — not in `src/`
- **Two-pass AI pipeline**: intent classification (`gpt-oss-120b`, reasoning high) then task planning (`gpt-oss-20b`, reasoning medium)
- **Streaming**: `application/x-ndjson` with event types: `status`, `ai.plan`, `todoist.task`, `final`, `error`
- **MCP integration**: Todoist via `StreamableHTTPClientTransport` with dynamic tool discovery and fallback aliases
- **Auth**: HTTP Basic Auth in `src/proxy.ts` using a Web Crypto SHA-256 constant-time compare (the file is the Next.js 16 successor to `middleware.ts`)
- **URL rewrite**: `/plan` rewrites to `/api/plan` in `next.config.ts`; `/transcribe` is called directly at `/api/transcribe`

## Required Environment Variables

Set in `.dev.vars` (local) or `wrangler secret put` (production):
- `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` — HTTP Basic Auth credentials
- `TODOIST_TOKEN` — Bearer token for Todoist MCP
- `TODOIST_MCP_URL` — MCP endpoint (defaults to `https://ai.todoist.net/mcp`)
- `FRONTEND_ORIGIN` — Allowed CORS origin (comma-separated for multiple)

## Code Conventions

- **Commits**: Conventional Commits format (`feat(scope):`, `fix(scope):`, `docs:`, etc.)
- **Path alias**: `@/*` maps to `./src/*`
- **Strict TypeScript**: `strict: true` in tsconfig
- **Zod validation**: All request bodies and AI responses validated with Zod schemas before use
- **Priority mapping**: Todoist API 4=highest (P1), 1=lowest (P4); bulk tools use string `p1`-`p4`

## Gotchas

- `pnpm dev` cannot call Workers AI models — use `pnpm preview` for full integration testing
- The `env.AI` binding requires `as unknown as { run: ... }` cast due to incomplete Cloudflare types
- No test suite exists yet — verify changes with `pnpm exec tsc --noEmit && pnpm lint`

## Key Documentation

- @docs/PLAN_PIPELINE.md — full pipeline architecture and MCP contract
- @openapi/plan.yaml — OpenAPI 3.1.0 spec for `/plan` and `/transcribe` endpoints
