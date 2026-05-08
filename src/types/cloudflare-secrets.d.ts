// `wrangler types` only inspects `vars` from wrangler.jsonc, so secrets
// supplied via `wrangler secret put` (or `.dev.vars` locally) must be
// declared here so the rest of the codebase can reference them as typed
// fields on Cloudflare.Env without ad-hoc casts. The lack of `export {}` is
// intentional: this file must remain an ambient script so the namespace
// merges with the one emitted by `cf-typegen`.
//
// DRIFT WARNING: keep these names disjoint from `wrangler.jsonc#vars`. If
// the same key ever appears in `vars`, `cf-typegen` will emit a competing
// declaration that TypeScript silently merges with the one below; any
// nullability mismatch then becomes a hidden type bug. When adding a new
// secret here, search wrangler.jsonc first.
declare namespace Cloudflare {
  interface Env {
    TODOIST_TOKEN: string;
    TODOIST_MCP_URL: string;
    FRONTEND_ORIGIN: string;
    BASIC_AUTH_USER: string;
    BASIC_AUTH_PASS: string;
  }
}
