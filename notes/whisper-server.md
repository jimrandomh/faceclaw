# Self-hosted Whisper transcription

The "Whisper server (self-hosted)" transcription provider sends voice audio to
any OpenAI-compatible Whisper server instead of a cloud service: vLLM, speaches
(faster-whisper-server), LocalAI and similar. It uses the batch endpoint
`POST {url}/audio/transcriptions` with a 16 kHz mono WAV. Push-to-talk
utterances are one request each; in Transcribe, each span ended by a pause is
one request. While a span is open its audio so far is re-sent every 1.5 s, so
text appears while you are still talking. A span that runs 25 s without a pause
(nonstop speech, music) is cut at its quietest moment in the last 5 s, so no
request outgrows Whisper's 30 s window; the pieces still arrive as one final.
On Android the WAV goes out through `FaceclawBinaryPost` (okhttp), since
NativeScript's http module copies a binary body into Java a byte at a time.

## Server

Any server exposing `/v1/models` and `/v1/audio/transcriptions` works, e.g.

    vllm serve openai/whisper-large-v3 --port 8004

## Settings (Settings > Voice)

- **Transcription Provider**: Whisper server (self-hosted). Disabled until the
  URL is set.
- **Whisper server URL**: the API root, e.g. `http://host:8004/v1`. A bare
  `http://host:8004` gets `/v1` added.
- **Whisper server model**: empty uses the first model the server lists.
- **Whisper language**: an ISO code such as `en`, or empty to auto-detect.
  A wrong fixed language makes Whisper translate rather than transcribe.
- **Whisper server key**: optional bearer token.

## iOS: plain http

iOS App Transport Security blocks plain `http://` to IP addresses (including
Tailscale's 100.x addresses) unless the app's Info.plist has an exception for
that host. Either serve the API over https (for example with `tailscale serve`)
or add your server to `NSExceptionDomains` in `App_Resources/iOS/Info.plist`
before building:

    <key>192.0.2.10</key>
    <dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>

## Transcribe on iOS

Transcribe needs a cloud or Whisper-server provider on iOS (Apple's recognizer
only handles short utterances). Its capture follows the glasses: a disconnect,
a glasses lock or backgrounding (for phone-mic capture) transcribes what was
already heard, and listening resumes once the glasses reconnect, unlock or the
app returns to the foreground. Without a glasses session the phone mic stands in
while Faceclaw is in the foreground. With "Save Transcribe audio" on (Voice
settings), each session's audio is kept as `transcribe-<time>.wav` in Downloads,
next to `transcript-<time>.txt` when the text is saved; a resumed capture keeps
appending to the same file.
