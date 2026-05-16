// @internal Public only for the test suite; consumers outside the planning
// pipeline should not depend on these helpers.

const PRIORITY_PATTERNS = [
  /(?:^|[^a-z0-9])p\s*([0-4])/,
  /priority\s*([0-4])/,
  /优先级\s*([0-4])/,
] as const;

const MAX_LABELS = 5;

// Todoist REST inverts the UI: 4 = P1 (highest), 1 = P4 (lowest). P0 is
// treated as P1 because the Todoist UI never exposes a higher level.
export function mapPriorityCueToApi(signal: string) {
  switch (signal) {
    case "0":
    case "1":
      return 4;
    case "2":
      return 3;
    case "3":
      return 2;
    case "4":
      return 1;
    default:
      return undefined;
  }
}

export function detectPriorityFromPrompt(prompt: string) {
  const normalized = prompt.toLowerCase();
  for (const pattern of PRIORITY_PATTERNS) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      const priority = mapPriorityCueToApi(match[1]);
      if (priority) {
        return priority;
      }
    }
  }
  return undefined;
}

export function clampPriority(priority?: number) {
  if (priority === undefined) {
    return undefined;
  }
  return Math.min(4, Math.max(1, Math.round(priority)));
}

// Todoist enforces a five-label cap per task; trim and dedupe before sending.
export function dedupeLabels(labels?: string[]) {
  if (!labels?.length) {
    return undefined;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) {
      continue;
    }
    seen.add(trimmed.toLowerCase());
    result.push(trimmed);
    if (result.length === MAX_LABELS) {
      break;
    }
  }
  return result.length ? result : undefined;
}
