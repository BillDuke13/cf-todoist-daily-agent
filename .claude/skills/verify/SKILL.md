---
name: verify
description: Run type checking and linting to verify changes are correct before committing.
---

Run the following checks sequentially and report results:

1. `pnpm exec tsc --noEmit` — TypeScript type check
2. `pnpm lint` — ESLint

If any step fails, show the errors and suggest fixes. Do not proceed to the next step if the current one fails.
