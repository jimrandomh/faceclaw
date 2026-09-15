/**
 * Wire-level pieces of the OpenAI Realtime transcription protocol, shared by
 * the OpenAI provider and self-hosted servers that speak the same protocol
 * (e.g. Speaches). No NativeScript imports, so tests/ can run it under node.
 */

export const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
export const OPENAI_REALTIME_MODEL = "gpt-realtime-whisper";
/** The Realtime API only accepts 24 kHz PCM16. */
export const REALTIME_SAMPLE_RATE = 24000;

/** OpenAI (GA schema): push-to-talk owns the utterance boundary; no server VAD. */
export function openAiSessionUpdate(model: string): object {
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
          transcription: { model },
          turn_detection: null,
        },
      },
    },
  };
}

/**
 * Self-hosted servers (beta schema, as implemented by Speaches).
 *
 * Speaches rejects `turn_detection: null`, and a turn_detection object must
 * carry all four fields below. So by default the server VAD is configured not
 * to fire: Silero's speech probability has to reach exactly 1.0 to start a
 * segment, and a long silence window. Speaches reports prefix_padding_ms as
 * unsupported on every such update, but applies the rest (see
 * classifyRealtimeError). create_response must be false: Speaches v0.8.3 (the
 * `latest` images) defaults it to true and would start an LLM response per
 * transcript. The model is set here because v0.8.3 ignores
 * `intent=transcription` and reads the URL model as the conversation model.
 *
 * serverVad: leave the server's VAD on with Speaches' own defaults, so the
 * server segments speech. Speaches evaluates a fixed 3 s window, so the
 * silence duration must stay well under 3000 ms.
 */
export function compatSessionUpdate(model: string, opts: { serverVad?: boolean } = {}): object {
  return {
    type: "session.update",
    session: {
      input_audio_transcription: { model },
      turn_detection: {
        type: "server_vad",
        threshold: opts.serverVad ? 0.9 : 1.0,
        silence_duration_ms: opts.serverVad ? 550 : 60000,
        prefix_padding_ms: 0,
        create_response: false,
      },
    },
  };
}

/**
 * WebSocket URL for a self-hosted server, or null when the settings don't
 * describe one. The host may carry a ws://, http://, wss:// or https:// prefix;
 * the secure ones select wss://. A blank port means 8000 (Speaches' default),
 * or 443 for a secure host.
 */
export function selfHostedRealtimeUrl(input: { host: string; port: string; model: string }): string | null {
  let host = input.host.trim();
  const model = input.model.trim();
  const scheme = /^(wss|https|ws|http):\/\//i.exec(host);
  const secure = scheme ? /^(wss|https)$/i.test(scheme[1]!) : false;
  if (scheme) host = host.slice(scheme[0].length);
  host = host.replace(/\/+$/, "");
  if (!host || !model) return null;
  const portText = input.port.trim();
  let port = secure ? 443 : 8000;
  if (portText) {
    if (!/^\d{1,5}$/.test(portText)) return null;
    port = Number(portText);
    if (port < 1 || port > 65535) return null;
  }
  return `${secure ? "wss" : "ws"}://${host}:${port}/v1/realtime?model=${encodeURIComponent(model)}&intent=transcription`;
}

export type RealtimeErrorAction = "ignore" | "commit-rejected" | "disconnect" | "fatal";

/**
 * How the client should react to a Realtime `error` event.
 * - ignore: advisory. Speaches reports "Specifying `session.<field>` is not
 *   supported" for fields it discards, then applies the rest of the update.
 * - commit-rejected: a commit on a (near-)empty buffer, e.g. a very quick
 *   push-to-talk tap, or a commit landing right after a server VAD commit.
 *   Nothing was committed, so one pending commit should be dropped.
 * - disconnect: transient; reconnect.
 * - fatal: anything else (bad key, unknown model, ...).
 */
export function classifyRealtimeError(
  error: { type?: string; code?: string | null; message?: string } | undefined,
): RealtimeErrorAction {
  const message = String(error?.message ?? "");
  if (message.startsWith("Specifying `session.")) return "ignore";
  if (message.startsWith("Error committing input audio buffer") || error?.code === "input_audio_buffer_commit_empty") {
    return "commit-rejected";
  }
  if (error?.code === "rate_limit_exceeded" || error?.type === "server_error") return "disconnect";
  return "fatal";
}
