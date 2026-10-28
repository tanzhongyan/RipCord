# 7. Telephony adapters in src/server/telephony

Date: 2026-10-28

## Context

Spec 0005 places provider phone calls behind a telephony adapter interface
(`placeCall`, `sendDigits`, `audio`, `bridgeHolder`, `hangUp`, plus
`answered`/`ended` events) with two implementations: a `simulated` adapter
that plays fixtures for the sandbox demo path, and a `twilio` adapter for
live calls. The adapters are shared infrastructure: the case executor drives
them in-process for simulated calls, and the voice worker drives them for
live Twilio media streams. They need a new `src/` directory (ADR +
`layout.allow`).

## Decision

- Adapters live in `src/server/telephony/` (`layout.allow` updated):
  the `TelephonyAdapter` interface and provider factory in `adapter.ts`,
  the fixture-driven `simulated` adapter in `simulated.ts`, the Twilio
  REST/TwiML adapter in `twilio.ts`, and the Muse Voice Transcribe client
  in `stt.ts`.
- Fixtures live in `src/server/telephony/fixtures/` (also allow-listed):
  `src/server/telephony/fixtures/demo-telco.json` lists
  `{ speaker, text, audio?, expectsDigits?, nextOnDigits }` turns. A turn
  with `audio` streams the WAV from `public/demo/` through
  speech-to-text; otherwise the adapter emits the text as the transcript
  (the spec's STT-down fallback).
- `TELEPHONY_PROVIDER` defaults to `simulated`, so development, tests and
  CI never touch the phone network. The factory reads it through
  `~/shared/config/env`, like every other module.
- Adapter selection never depends on per-call state: sandbox cases always
  get `simulated`, and only a live case (spec 0005's three-part gate) may
  get `twilio`.
- Speech audio is never stored: chunks stream to transcription and are
  discarded, per the data contract's retention table.

## Consequences

- The executor and the voice worker share one adapter interface, so the
  demo path and live calls run the same turn logic.
- No new dependencies: the Twilio adapter uses the installed `twilio`
  client, and transcription uses `fetch`/`WebSocket` against the Meta
  endpoint.
