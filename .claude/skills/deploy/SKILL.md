---
name: deploy
description: Build and deploy to Cloudflare Workers. User-only — requires confirmation before running.
disable-model-invocation: true
---

Deploy the application to Cloudflare Workers:

1. Run `/verify` first to ensure no type or lint errors
2. Run `pnpm run deploy` (builds with OpenNext then deploys via Wrangler)
3. Report the deployment URL and any errors
