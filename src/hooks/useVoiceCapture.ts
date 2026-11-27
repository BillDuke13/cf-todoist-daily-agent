import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const VOICE_TIMEOUT_MS = 60_000;
const STATUS_RESET_MS = 2_500;

type UseVoiceCaptureOptions = {
  disabled?: boolean;
  onTranscript: (text: string) => void;
};

export type VoiceCaptureState = {
  supported: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  status: string | null;
  error: string | null;
  toggle: () => void;
};

export function useVoiceCapture({
  disabled = false,
  onTranscript,
}: UseVoiceCaptureOptions): VoiceCaptureState {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const recordingTimeoutRef = useRef<number | null>(null);
  const statusTimeoutRef = useRef<number | null>(null);
  const skipUploadRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const supported = useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof navigator !== "undefined" &&
      "mediaDevices" in navigator &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof window.MediaRecorder !== "undefined",
    [],
  );

  const clearRecordingTimeout = useCallback(() => {
    if (recordingTimeoutRef.current !== null) {
      window.clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
  }, []);

  const clearStatusTimeout = useCallback(() => {
    if (statusTimeoutRef.current !== null) {
      window.clearTimeout(statusTimeoutRef.current);
      statusTimeoutRef.current = null;
    }
  }, []);

  const stopStreamTracks = useCallback(() => {
    if (!mediaStreamRef.current) {
      return;
    }
    for (const track of mediaStreamRef.current.getTracks()) {
      track.stop();
    }
    mediaStreamRef.current = null;
  }, []);

  const stopRecording = useCallback(
    (options?: { skipTranscription?: boolean }) => {
      if (!mediaRecorderRef.current) {
        return;
      }
      clearRecordingTimeout();
      if (options?.skipTranscription) {
        skipUploadRef.current = true;
      }
      if (mediaRecorderRef.current.state === "inactive") {
        skipUploadRef.current = false;
        stopStreamTracks();
        setIsRecording(false);
        return;
      }
      mediaRecorderRef.current.stop();
    },
    [clearRecordingTimeout, stopStreamTracks],
  );

  const transcribeAudio = useCallback(
    async (blob: Blob) => {
      clearStatusTimeout();
      setIsTranscribing(true);
      setStatus("Transcribing audio…");
      setError(null);
      let transcriptApplied = false;
      try {
        const base64 = await blobToBase64(blob);
        const response = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: base64 }),
        });
        const payload = await readJsonSafe<{ text?: string; title?: string; detail?: string }>(
          response,
        );
        if (!response.ok || !payload?.text) {
          throw new Error(payload?.detail || payload?.title || "Unable to transcribe audio");
        }
        const normalized = payload.text.trim();
        if (!normalized.length) {
          setError("Transcription was empty. Please try again.");
          return;
        }
        onTranscriptRef.current(normalized);
        transcriptApplied = true;
        setStatus("Transcription ready");
        statusTimeoutRef.current = window.setTimeout(() => {
          statusTimeoutRef.current = null;
          setStatus(null);
        }, STATUS_RESET_MS);
      } catch (caught) {
        console.error("Transcription failed", caught);
        setError(caught instanceof Error ? caught.message : "Unable to transcribe audio");
        setStatus(null);
      } finally {
        setIsTranscribing(false);
        if (!transcriptApplied) {
          setStatus(null);
        }
      }
    },
    [clearStatusTimeout],
  );

  const toggle = useCallback(async () => {
    if (isRecording) {
      stopRecording();
      return;
    }
    if (!supported) {
      setError("Voice capture is not supported in this browser.");
      return;
    }
    if (disabled) {
      setError("Please wait for the current plan to finish before starting a new recording.");
      return;
    }
    try {
      clearStatusTimeout();
      setError(null);
      setStatus("Requesting microphone access…");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = selectMimeType();
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = async () => {
        clearRecordingTimeout();
        stopStreamTracks();
        setIsRecording(false);
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        if (skipUploadRef.current) {
          skipUploadRef.current = false;
          setStatus(null);
          return;
        }
        if (!blob.size) {
          setStatus(null);
          setError("No audio was captured.");
          return;
        }
        await transcribeAudio(blob);
      };
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setStatus("Recording… tap again to stop");
      recordingTimeoutRef.current = window.setTimeout(() => {
        setStatus("Recording stopped after 60 seconds.");
        stopRecording();
      }, VOICE_TIMEOUT_MS);
    } catch (caught) {
      console.error("Voice capture failed", caught);
      setStatus(null);
      setError(caught instanceof Error ? caught.message : "Unable to access the microphone");
      stopStreamTracks();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        skipUploadRef.current = true;
        mediaRecorderRef.current.stop();
      }
    }
  }, [
    isRecording,
    supported,
    disabled,
    clearStatusTimeout,
    stopRecording,
    clearRecordingTimeout,
    stopStreamTracks,
    transcribeAudio,
  ]);

  useEffect(() => {
    return () => {
      clearStatusTimeout();
      stopRecording({ skipTranscription: true });
      stopStreamTracks();
    };
  }, [clearStatusTimeout, stopRecording, stopStreamTracks]);

  return { supported, isRecording, isTranscribing, status, error, toggle };
}

async function readJsonSafe<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function selectMimeType() {
  if (
    typeof MediaRecorder !== "undefined" &&
    MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
  ) {
    return "audio/webm;codecs=opus";
  }
  return "audio/webm";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read audio blob"));
    reader.readAsDataURL(blob);
  });
}
