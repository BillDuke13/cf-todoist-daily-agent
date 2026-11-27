export function stripJsonFence(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const firstLineBreak = trimmed.indexOf("\n");
  if (firstLineBreak === -1) {
    return trimmed;
  }
  const fenceEnd = trimmed.lastIndexOf("```");
  if (fenceEnd <= firstLineBreak) {
    return trimmed.slice(firstLineBreak + 1).trim();
  }
  return trimmed.slice(firstLineBreak + 1, fenceEnd).trim();
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const cause = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Workers AI returned invalid JSON (${cause})`);
  }
}

// Workers AI returns either chat-completions (`choices[0].message`) or
// Responses API (`output[].content[]`) envelopes depending on the model.
export function extractResponsePayload(response: unknown): unknown {
  if (!response || typeof response !== "object") {
    throw new Error("Workers AI returned an empty response");
  }

  const chatMessage = (
    response as {
      choices?: Array<{ message?: { parsed?: unknown; content?: Array<{ text?: string }> } }>;
    }
  ).choices?.[0]?.message;

  if (chatMessage?.parsed) {
    return chatMessage.parsed;
  }
  if (chatMessage?.content?.length) {
    const textChunk = chatMessage.content.find((chunk) => chunk?.text);
    if (textChunk?.text) {
      return safeJsonParse(stripJsonFence(textChunk.text));
    }
  }

  const outputs = (
    response as {
      output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
    }
  ).output;

  if (outputs?.length) {
    for (const chunk of outputs) {
      if (chunk.type !== "message" || !chunk.content?.length) {
        continue;
      }
      const textBlock = chunk.content.find((item) => typeof item.text === "string");
      if (textBlock?.text) {
        return safeJsonParse(stripJsonFence(textBlock.text));
      }
    }
  }

  return response;
}

export function normalizePlanPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      summary: undefined,
      tasks: value,
    };
  }
  return value;
}

export function extractPlanPayload(response: unknown): unknown {
  return normalizePlanPayload(extractResponsePayload(response));
}
