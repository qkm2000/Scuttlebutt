# Scuttlebutt

> _Scuttlebutt_ (n.): the ship's gossip — the talk, the news, what everyone's discussing.

A local-first meeting companion that lives in your Obsidian sidebar, inspired by [anarlog](https://anarlog.so). Record (or import) a meeting, transcribe it against your local Whisper/vLLM server, auto-summarize it with your local LLM, review the **Summary / Transcript / Memo** side-by-side, then save one tidy note with a clean title and tags.

Local-first: everything runs against endpoints you configure. No cloud, no accounts.

## Why "Scuttlebutt"?

On old sailing ships, the **scuttlebutt** was the cask of drinking water the crew gathered around — a *scuttle* (a hole cut in something) tapped into a *butt* (a large barrel). It was the ship's water cooler, and because sailors swapped news and gossip while drinking there, "scuttlebutt" came to mean **the talk, the rumors, the news — what everyone's discussing**.

That's exactly what this plugin captures: the scuttlebutt of your meetings, turned into notes you can keep.

## What it does

```
record | import  →  transcribe  →  summarize (+ title + tags)  →  review in sidebar  →  save note
```

- **Record** microphone audio (optionally mixing in system audio) right from the sidebar, with a live timer, an in-sidebar audio player, and a status-bar indicator so you can keep working.
- **Import** an existing audio clip from your vault or upload one from disk.
- **Transcribe** via any OpenAI-compatible speech endpoint (vLLM Whisper, `whisper.cpp` server, etc.). Re-transcribe from the Transcript tab any time.
- **Summarize** via any OpenAI-compatible chat endpoint. Uses anarlog's summary format (h1 sections, 3+ concrete bullets, decisions & action items).
- **Context files** — pick any vault notes (agenda, prior meetings) to steer the summary.
- **Review** everything in the sidebar: edit the summary, transcript, memo, title, and tags before saving.
- **Save** a single note: frontmatter (`title`, `date`, `tags`, `participants`, `audio`), the summary, and the transcript/memo tucked into collapsible callouts.

## Elegant, anarlog-style output

- **Title** — the LLM proposes a super-concise topic title (no punctuation clutter).
- **Tags** — 3–5 specific tags, reusing your existing vault tags where relevant and falling back to a sensible default vocabulary (`Product`, `Engineering`, `Research`, `Design`, …).
- **File name** — `YYYY-MM-DD — Topic Title.md`, so notes sort chronologically and read cleanly.

## Install (from source)

```bash
npm install
npm run build           # or: node esbuild.js --watch  (watch mode)
bash install.sh ~/path/to/your/vault
```

Then enable it in **Settings → Community plugins → Scuttlebutt**, and click the **mic** ribbon icon to open the sidebar.

## Configure

Open **Settings → Scuttlebutt**. There are two endpoints; each has a **URL**, **API key**, **Test**, and **Model** dropdown. Click **Test** to validate the endpoint and load its model list — on success the dropdown fills in, on failure it blanks out.

- **Transcription** — your Whisper/vLLM server, e.g. `http://localhost:8000/v1`
- **Summary** — your LLM/vLLM server, e.g. `http://localhost:8001/v1`

Other options: input device (see below), spoken/summary language, auto-summarize, title & tag suggestion, output folders, save-audio, and the summary system prompt (with a reset-to-default button).

## Development

```bash
npm run build     # bundle the plugin to ./main.js
npm test          # run the unit tests (Node's built-in test runner)
```

The pure logic (file naming, tag/transcript parsing, multipart encoding, …) lives in `src/utils.ts` and is covered by `tests/utils.test.ts`. Obsidian- and DOM-dependent code lives in `src/main.ts`.

## Notes on system audio

Scuttlebutt runs as an Obsidian plugin (JavaScript in Electron), so it's limited to the browser's `getUserMedia` / `getDisplayMedia` APIs. On macOS those **cannot** capture system audio the way a native app (like anarlog, which uses Core Audio process taps) can. To record the other side of a call on macOS, install a loopback device such as [BlackHole](https://existential.audio/blackhole/), create an Aggregate Device that includes it, and select that device under **Settings → Capture → Input device**. When "Capture system audio" yields no track, Scuttlebutt tells you and continues with the microphone.

## Notes

- The UI is styled entirely with Obsidian's own theme variables, so it adapts to any light/dark theme.
- Requests go through Obsidian's `requestUrl`, which avoids browser CORS restrictions when calling local servers.
- Desktop only (recording uses the microphone).

## License

MIT © Kar Min
