import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // ~8MB after base64 decoding.

const whisperRequestSchema = z.object({
  audio: z.string().min(16, "Audio payload is required"),
  language: z.string().min(2).optional(),
  task: z.enum(["transcribe", "translate"]).optional(),
});

/**
 * Accepts a base64 encoded WebM/Opus clip, enforces the 8MB guard rail, and relays it
 * to Workers AI Whisper so the front-end can reuse the transcript as a regular prompt.
 */
export async function POST(request: NextRequest) {
  const { env } = getCloudflareContext();
  const body = await readJson(request);
  const parsed = whisperRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.flatten().formErrors.join("; ") || "Invalid request body",
      },
      { status: 400 },
    );
  }

  const estimatedBytes = Math.floor((parsed.data.audio.length / 4) * 3);
  if (estimatedBytes > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      {
        error: "Audio payload exceeds the maximum size of 8MB",
      },
      { status: 413 },
    );
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

    return NextResponse.json({
      text: response.text,
      language: response.transcription_info?.language,
    });
  } catch (error) {
    console.error("/api/transcribe error", error);
    return NextResponse.json(
      {
        error: "Unable to transcribe audio",
      },
      { status: 500 },
    );
  }
}

/** Gracefully handles malformed JSON bodies so the caller receives a 400 instead of crashing. */
async function readJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
