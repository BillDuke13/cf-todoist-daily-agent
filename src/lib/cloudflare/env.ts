export type WorkersAiBinding = {
  run: (model: string, payload: Record<string, unknown>) => Promise<unknown>;
};

// Generated Workers AI binding types do not cover newer Responses/Whisper inputs.
export function getWorkersAi(env: CloudflareEnv): WorkersAiBinding {
  return env.AI as unknown as WorkersAiBinding;
}

// `wrangler types` narrows `DEBUG_EVENTS` to the literal `"false"` from
// `wrangler.jsonc#vars`; cast through `unknown` so `wrangler secret put` overrides work.
export function isDebugEnabled(env: CloudflareEnv): boolean {
  return (env as unknown as { DEBUG_EVENTS?: string }).DEBUG_EVENTS === "true";
}
