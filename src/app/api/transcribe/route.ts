import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";
import { getWorkersAi } from "@/lib/cloudflare/env";
import { buildCorsHeaders } from "@/lib/http/cors";
import { problemResponse, zodIssuesToErrors } from "@/lib/http/errors";
import {
  exceedsDeclaredLength,
  handleCorsPreflight,
  isJsonContentType,
  readJsonBody,
  resolveRequestOrigin,
} from "@/lib/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WHISPER_MODEL_ID = "@cf/openai/whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
// Base64 inflates payloads by ~4/3; add headroom for the JSON envelope.
const MAX_REQUEST_BYTES = Math.ceil(MAX_AUDIO_BYTES * 1.4) + 1024;

const whisperRequestSchema = z
  .object({
    audio: z.string().min(16, "Audio payload is required"),
    language: z.string().min(2).optional(),
    task: z.enum(["transcribe", "translate"]).optional(),
  })
  .strict();

export async function OPTIONS(request: NextRequest) {
  const { env } = getCloudflareContext();
  return handleCorsPreflight(request, env.FRONTEND_ORIGIN);
}

export async function POST(request: NextRequest) {
  const { env } = getCloudflareContext();
  const originResult = resolveRequestOrigin(request, env.FRONTEND_ORIGIN);
  if (!originResult.ok) {
    return originResult.response;
  }
  const { origin } = originResult;

  if (!isJsonContentType(request)) {
    return problemResponse({
      status: 415,
      code: "unsupported_media_type",
      detail: "Content-Type must be application/json",
      headers: buildCorsHeaders(origin),
    });
  }

  if (exceedsDeclaredLength(request, MAX_REQUEST_BYTES)) {
    return problemResponse({
      status: 413,
      code: "payload_too_large",
      detail: "Audio payload exceeds the maximum size of 8MB",
      headers: buildCorsHeaders(origin),
    });
  }

  const body = await readJsonBody(request);
  const parsed = whisperRequestSchema.safeParse(body);
  if (!parsed.success) {
    return problemResponse({
      status: 400,
      code: "validation_failed",
      errors: zodIssuesToErrors(parsed.error),
      headers: buildCorsHeaders(origin),
    });
  }

  const estimatedBytes = Math.floor((parsed.data.audio.length / 4) * 3);
  if (estimatedBytes > MAX_AUDIO_BYTES) {
    return problemResponse({
      status: 413,
      code: "payload_too_large",
      detail: "Audio payload exceeds the maximum size of 8MB",
      headers: buildCorsHeaders(origin),
    });
  }

  const ai = getWorkersAi(env);
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

    const response = (await ai.run(WHISPER_MODEL_ID, payload)) as {
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
    return problemResponse({
      status: 500,
      code: "transcription_failed",
      detail: "Unable to transcribe audio",
      headers: buildCorsHeaders(origin),
    });
  }
}
