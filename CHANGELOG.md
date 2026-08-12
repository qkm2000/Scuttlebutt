# Changelog

All notable changes to Scuttlebutt are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/).

## [1.0.3] — All Hands (2026-08-12)

### Added

- **Mix in system audio.** A new "System audio device" picker (Settings →
  Capture) records a second input alongside the microphone and mixes them into
  one track — point it at a loopback device (e.g. BlackHole on macOS) to capture
  meeting/system audio. The screen-share capture remains as an alternative.
- **Cancel a running job.** Transcription and summarization now run over a
  cancellable request, with a Cancel button beside the progress bar; your audio
  and any existing work are kept.
- **Configurable request timeouts.** Each server (Transcription, Summary) has
  its own timeout in seconds, where `0` means wait indefinitely — handy for long
  recordings on a slow or busy server. Each has a reset-to-default button.
- **Per-recording speaker identification.** The "Identify speakers" toggle also
  lives in the sidebar now, seeded from the global default, so diarization can be
  flipped per recording.

### Fixed

- Tag and participant inputs keep focus after Enter, so several can be added in a
  row without the cursor jumping away.
- Settings actions no longer scroll the page back to the top — the endpoint-URL
  and prompt reset buttons, and "Detect input devices", update in place.
- The device/model dropdowns no longer stretch the settings row when they hold
  long names.

## [1.0.2] — Roll Call (2026-07-27)

- **Speaker identification (diarization).** An "Identify speakers" toggle
  (Settings → Transcription, off by default). With a diarizing endpoint,
  transcripts are split into `Speaker 1:` / `Speaker 2:` turns, merging
  consecutive turns from the same speaker. Endpoints that can't diarize fall
  back to a flat transcript with a heads-up notice, so nothing breaks.
- **Reset-to-default buttons** on the Transcription and Summary endpoint URLs —
  one click to restore the default.

## [1.0.1] — Maiden Voyage (2026-07-24)

First public release.

- Record or import meeting audio from the sidebar.
- Transcription via any OpenAI-compatible speech endpoint.
- Auto-summary via any OpenAI-compatible chat endpoint, with an LLM-generated
  title and tags in an anarlog-style format.
- Context files to steer the summary, and a single consolidated note per meeting.
