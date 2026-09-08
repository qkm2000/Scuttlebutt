# Changelog

All notable changes to Scuttlebutt are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/).

## [1.0.5] - Belay That (2026-09-08)

### Added

- **Pause and resume a recording.** A split control in the sidebar (Pause/Resume
  and Stop) and a "Pause / resume recording" command (bindable to a hotkey) let
  you pause an in-progress recording and pick it back up later. The recording is
  captured as one continuous file and transcribed as a single clip.

### Changed

- Releases are now built and published by GitHub Actions with build provenance
  attestations for main.js, manifest.json, and styles.css.
- Added a Data and privacy section to the README covering what the plugin
  accesses locally and what it sends to your configured servers.

### Fixed

- Recording duration (in the timer, status bar, and saved filename) now excludes
  paused time, so it reflects the actual recorded audio length.

## [1.0.4] — Loose Lips (2026-09-07)

### Added

- **Streaming summaries.** The summary now streams in token by token instead of
  appearing all at once — far less waiting on slower local models. Toggle it in
  Settings → Summary ("Stream summary", on by default) or per recording. Falls
  back to a single request automatically on servers that can't stream.
- **Model thinking, shown separately.** For reasoning models (e.g. Qwen3), the
  `<think>` reasoning is captured and shown in a collapsible "Model thinking"
  section under the summary — hidden by default, and streamed live when enabled.
  It's never written into the saved note.
- **Reasoning effort control.** A new "Reasoning effort" setting (Off / Low /
  Medium / High / Extra high / Max), also available per recording. "Off" disables
  thinking (recommended for summaries); higher levels enable it and reserve token
  headroom so the reasoning never crowds out the answer.
- **Regenerate title or tags on their own.** Small refresh buttons beside the
  Title and Tags fields re-run just that piece from the current summary.
- **Run options.** The per-recording controls (Identify speakers · Thinking ·
  Stream summary) now live in one collapsible "Run options" section in the
  sidebar. They seed from your settings and stick until you press "New".

### Changed

- Default request timeouts are now 300 s for both Transcription and Summary.
- Dropdowns are a consistent fixed width that no longer resizes with the selected
  option, and shrink to fit a narrow pane instead of squishing labels.
- The input-device list is cached, so your selected devices show immediately after
  a reload without having to re-detect them.

### Fixed

- **Thinking models no longer return a blank summary, title, and tags.** Models
  like Qwen3 spent the whole token budget on `<think>` and returned nothing;
  their reasoning is now stripped from the answer and given its own headroom.

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
