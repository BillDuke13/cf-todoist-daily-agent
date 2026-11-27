// Ambient declarations for secrets supplied via `wrangler secret put` or `.dev.vars`.
// Keep this file without top-level imports/exports so interfaces merge with `cloudflare-env.d.ts`,
// and keep keys disjoint from `wrangler.jsonc#vars`.
// Wrangler 4.168+ emits `Cloudflare.Env` and `CloudflareEnv` as sibling interfaces, so declare both.
declare namespace Cloudflare {
  interface Env {
    TODOIST_TOKEN: string;
    TODOIST_MCP_URL: string;
    FRONTEND_ORIGIN: string;
    BASIC_AUTH_USER: string;
    BASIC_AUTH_PASS: string;
  }
}

interface CloudflareEnv {
  TODOIST_TOKEN: string;
  TODOIST_MCP_URL: string;
  FRONTEND_ORIGIN: string;
  BASIC_AUTH_USER: string;
  BASIC_AUTH_PASS: string;
}
