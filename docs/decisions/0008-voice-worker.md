# 8. Voice worker as a separate Bun process

Date: 2026-10-28

## Context

Spec 0005 runs long phone calls in a voice worker: Twilio media streams
need a long-lived WebSocket (`wss://<worker>/twilio/stream`), which Next.js
route handlers do not host. The worker shares the database, Valkey and the
vault module with the app, and publishes transcript and card events to
`case:<id>`. It needs a new `src/` directory (ADR + `layout.allow`) and a
start command.

## Decision

- The worker lives in `src/server/voice-worker/` (`layout.allow`
  updated) and starts with `bun run voice-worker`. It serves the Twilio
  media-stream WebSocket at `/twilio/stream` and nothing else.
- Turn logic is not duplicated: the worker imports the call runner from
  `~/features/cases` (the sanctioned barrel path for cross-feature server
  reuse) and the telephony adapters from `~/server/telephony`. Only the
  transport (media frames in, TwiML updates out) is worker-owned.
- Twilio μ-law 8 kHz frames are transcoded to PCM 16 kHz in worker code
  (no new dependency) and streamed to Muse Voice Transcribe realtime;
  partial transcripts forward to `case:<id>` as SSE `transcript` events.
- The worker is P1: it ships after the B10 demo-path test passes on the
  simulated adapter. Until then `TELEPHONY_PROVIDER` stays `simulated`
  and the worker idles with no calls.

## Consequences

- `package.json` gains the `voice-worker` script and a knip entry for the
  worker main file, so dead-code detection still passes.
- Deployment runs two processes (Next.js + worker); local development
  needs only Next.js while telephony stays simulated.
