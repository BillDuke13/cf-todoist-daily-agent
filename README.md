# Todoist Daily Agent

A Cloudflare Worker + Next.js 16 reference implementation that plans a focused day with Workers AI, streams the intermediate events to the browser, and syncs the resulting tasks into Todoist through the official Model Context Protocol (MCP) Streamable HTTP endpoint. The project is distributed under the Apache 2.0 License (see [LICENSE](LICENSE)).

## Architecture Overview
- **Frontend**: React 19 App Router page (`src/app/page.tsx`) that captures a single natural-language prompt, streams NDJSON events from `/plan`, and optionally records a short voice note that flows through `/api/transcribe`.
- **Planning pipeline**: `/plan` (documented in [`openapi/plan.yaml`](openapi/plan.yaml)) validates the request, runs intent classification + scenario-specific planning with `@cf/openai/gpt-oss-120b` / `@cf/openai/gpt-oss-20b`, discovers Todoist projects/labels dynamically, and streams every stage as newline-delimited JSON. Details live in [`docs/PLAN_PIPELINE.md`](docs/PLAN_PIPELINE.md).
- **Todoist MCP integration**: Uses `StreamableHTTPClientTransport` to connect to `https://ai.todoist.net/mcp`, lists whatever metadata/tools are available (legacy or official), and calls `add-task(s)` with both `projectId` and `project_id` fields plus normalized priorities (`p1…p4`).
- **Voice transcription**: `/api/transcribe` proxies base64 WebM/Opus audio to `@cf/openai/whisper-large-v3-turbo`, enforcing an 8 MB limit so the front-end can overwrite the prompt and immediately submit `/plan`.

## Features
- **Intent-aware planning**: `single_reminder`, `multi_step_plan`, `recipe_plan`, and `general_plan` templates enforce task counts, dependencies, and tone.
- **Metadata-driven prompts**: Todoist projects/labels fetched via MCP are injected into the AI prompt and exposed through `debug.metadata` events to minimize “Inbox” fallbacks.
- **Priority normalization**: Natural-language cues such as `P0`, `P1`, or “high priority” map to Todoist REST priority numbers (`4 = P1`, `1 = P4`). Bulk tools automatically convert to `p1…p4` strings.
- **Streaming UX**: `/plan` replies with `application/x-ndjson` events (`status`, `ai.plan`, `todoist.task`, `final`, `error`) so the UI can display progress and failures instantly.
- **Voice-first flow**: Browser MediaRecorder → `/api/transcribe` → prompt submission in one click, with graceful fallbacks when permissions or size limits fail.

## Prerequisites
- Node.js 20+
- `pnpm` 9+
- Wrangler CLI 4.45+
- Cloudflare account with Workers AI enabled
- Todoist account + API token approved for the MCP beta (`https://ai.todoist.net/mcp`)

## Configuration
| Name | Description |
| --- | --- |
| `FRONTEND_ORIGIN` | Single allowed origin for CORS and Basic Auth prompts. |
| `TODOIST_MCP_URL` | MCP Streamable HTTP endpoint (default `https://ai.todoist.net/mcp`). |
| `TODOIST_TOKEN` | Bearer token recognized by Todoist MCP. |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | Credentials for HTTP Basic auth across `/plan` and `/transcribe`. |
| `AI` binding | Configured in `wrangler.jsonc` to access Workers AI (e.g., `binding: "AI"`). |

Populate `.dev.vars` for local runs, then set the same names in Cloudflare via `wrangler secret put`.

## Local Development
```bash
pnpm install
pnpm dev          # Next.js dev server (no Worker bindings)
pnpm lint         # ESLint flat config for Next.js 16 + TS strict
pnpm preview      # Build via OpenNext + Wrangler preview
wrangler dev      # Run the Worker locally at http://127.0.0.1:8787
```
Example streaming request:
```bash
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
     -N -H "Content-Type: application/json" \
     -H "Origin: $FRONTEND_ORIGIN" \
     -d '{"prompt":"Plan a mindful evening"}' \
     http://127.0.0.1:8787/plan
```

## Deployment
```bash
pnpm run deploy   # Builds with opennextjs-cloudflare and runs `wrangler deploy`
```
The script produces `.open-next/worker.js`, uploads static assets, and publishes to `wrangler.jsonc`'s Worker name.

## Observability & Debugging
1. Tail logs with sanitization disabled to capture Todoist payloads:
   ```bash
   LOG_FILE=$(mktemp -t wrangler-tail).log
   WRANGLER_LOG_SANITIZE=false npx wrangler tail cf-todoist-daily-agent --format json > "$LOG_FILE" 2>&1 &
   ```
2. Trigger `/plan` while the tail is running. Look for:
   - `[todoist.tools]` – discovered MCP tools.
   - `[todoist.debug.metadata]` – first few projects/labels (confirms metadata scope).
   - `[todoist.debug.call-args]` – exact `add-task(s)` payload (check `project_id`, `priority`, `due*`).
3. Cross-reference the Todoist Activity Log to confirm tasks landed in the expected project and priority.

## API Summary
- `OPTIONS /plan` – CORS preflight (204).
- `POST /plan` – Main planner endpoint returning `application/x-ndjson` (see [`openapi/plan.yaml`](openapi/plan.yaml)).
- `POST /transcribe` – Voice helper, returns `{ text, language }` or an error payload.

OpenAPI schemas define request/response bodies for automation and client generation.

## Testing & Verification
- `pnpm lint`
- `pnpm preview`
- `wrangler dev --local` followed by a sample curl (as above) to validate NDJSON streaming and Todoist MCP connectivity.

## Contributing
Issues and pull requests are welcome. Please follow Conventional Commits and run the test matrix above before submitting PRs. When touching docs, keep `docs/` (English) and Serena memories (Chinese, git-ignored) in sync per the Agents Playbook.

## License
Licensed under the [Apache License, Version 2.0](LICENSE).
