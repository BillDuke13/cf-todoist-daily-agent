/**
 * Pure helpers for prompt-driven Todoist priority/label normalization.
 * Extracted so they can be unit-tested without spinning up a Next.js
 * route handler.
 *
 * @internal Public only for the test suite; do not import from app code
 *   that is not already responsible for the planning pipeline.
 */

const PRIORITY_PATTERNS = [
  /(?:^|[^a-z0-9])p\s*([0-4])/,
  /priority\s*([0-4])/,
  /优先级\s*([0-4])/,
] as const;

const MAX_LABELS = 5;

/**
 * Convert a UI-facing P-number ("0".."4") into the Todoist REST priority
 * value where 4 is highest urgency (P1) and 1 is lowest (P4).
 */
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

/**
 * Scan the prompt for "P{n}", "priority {n}", or the localized "优先级{n}"
 * pattern and return the corresponding Todoist API priority. Returns
 * undefined when no recognizable cue is present.
 */
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

/** Clamp a priority to the [1, 4] Todoist API range, rounding floats. */
export function clampPriority(priority?: number) {
  if (priority === undefined) {
    return undefined;
  }
  return Math.min(4, Math.max(1, Math.round(priority)));
}

/**
 * Trim, dedupe (case-insensitive), and cap a list of Todoist labels at
 * five entries. Returns undefined when the input is empty or every entry
 * collapses away.
 */
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
