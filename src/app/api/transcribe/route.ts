import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";
import { OriginNotAllowedError, buildCorsHeaders, forbidden, resolveOrigin } from "@/lib/cors";
import { problemResponse, zodIssuesToErrors } from "@/lib/errors";

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

  if (!isJsonRequest(request)) {
    return problemResponse({
      status: 415,
      code: "unsupported_media_type",
      detail: "Content-Type must be application/json",
      headers: buildCorsHeaders(origin),
    });
  }

  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return problemResponse({
      status: 413,
      code: "payload_too_large",
      detail: "Audio payload exceeds the maximum size of 8MB",
      headers: buildCorsHeaders(origin),
    });
  }

  const body = await readJson(request);
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
    return problemResponse({
      status: 500,
      code: "transcription_failed",
      detail: "Unable to transcribe audio",
      headers: buildCorsHeaders(origin),
    });
  }
}

function isJsonRequest(request: NextRequest) {
  return (request.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

async function readJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
