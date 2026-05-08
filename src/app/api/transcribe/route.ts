import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";
import { OriginNotAllowedError, buildCorsHeaders, forbidden, resolveOrigin } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // 8MB after base64 decoding.
// Base64 inflates the payload ~4/3; allow a small JSON envelope on top.
const MAX_REQUEST_BYTES = Math.ceil(MAX_AUDIO_BYTES * 1.4) + 1024;

const whisperRequestSchema = z.object({
  audio: z.string().min(16, "Audio payload is required"),
  language: z.string().min(2).optional(),
  task: z.enum(["transcribe", "translate"]).optional(),
});

export async function OPTIONS(request: NextRequest) {
  const { env } = getCloudflareContext();
  let origin: string;
  try {
    origin = resolveOrigin(request, env.FRONTEND_ORIGIN);
  } catch (error) {
    if (error instanceof OriginNotAllowedError) {
      return forbidden();
    }
    throw error;
  }
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(origin, { "Access-Control-Max-Age": "600" }),
  });
}

/**
 * Accepts a base64 encoded WebM/Opus clip, enforces the 8MB guard rail, and relays it
 * to Workers AI Whisper so the front-end can reuse the transcript as a regular prompt.
 */
export async function POST(request: NextRequest) {
  const { env } = getCloudflareContext();
  let origin: string;
  try {
    origin = resolveOrigin(request, env.FRONTEND_ORIGIN);
  } catch (error) {
    if (error instanceof OriginNotAllowedError) {
      return forbidden();
    }
    throw error;
  }

  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return errorResponse("Audio payload exceeds the maximum size of 8MB", origin, 413);
  }

  const body = await readJson(request);
  const parsed = whisperRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      parsed.error.flatten().formErrors.join("; ") || "Invalid request body",
      origin,
      400,
    );
  }

  const estimatedBytes = Math.floor((parsed.data.audio.length / 4) * 3);
  if (estimatedBytes > MAX_AUDIO_BYTES) {
    return errorResponse("Audio payload exceeds the maximum size of 8MB", origin, 413);
  }

  const ai = env.AI as unknown as {
    run: (model: string, payload: Record<string, unknown>) => Promise<unknown>;
  };

  try {
    const payload: Record<string, unknown> = {
      audio: parsed.data.audio,
    };
    if (parsed.data.language) {
      payload.language = parsed.data.language;
    }
    if (parsed.data.task) {
      payload.task = parsed.data.task;
    }

    const response = (await ai.run("@cf/openai/whisper-large-v3-turbo", payload)) as {
      text?: string;
      transcription_info?: { language?: string };
    };

    if (!response || typeof response !== "object" || !response.text) {
      throw new Error("Whisper did not return text");
    }

    return NextResponse.json(
      {
        text: response.text,
        language: response.transcription_info?.language,
      },
      { headers: buildCorsHeaders(origin) },
    );
  } catch (error) {
    console.error("/api/transcribe error", error);
    return errorResponse("Unable to transcribe audio", origin, 500);
  }
}

function errorResponse(message: string, origin: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: buildCorsHeaders(origin, { "Content-Type": "application/json" }),
  });
}

/** Gracefully handles malformed JSON bodies so the caller receives a 400 instead of crashing. */
async function readJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
