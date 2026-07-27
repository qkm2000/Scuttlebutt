# Changelog

All notable changes to Scuttlebutt are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/).

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
