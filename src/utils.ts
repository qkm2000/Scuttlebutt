/*
 * Pure helpers for Scuttlebutt.
 *
 * Everything here is free of the `obsidian` runtime and of DOM/`window` access,
 * so it can be unit-tested with Node's built-in test runner. Keep it that way:
 * anything that touches the Obsidian API or the DOM belongs in main.ts.
 */

/** Join a base URL and a path with exactly one slash between them. */
export function joinUrl(base: string, path: string): string {
	return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

/** Shorten a string to `max` chars, appending an ellipsis when truncated. */
export function truncate(s: string, max = 300): string {
	if (!s) return '';
	return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Format a millisecond duration as m:ss, or h:mm:ss once past an hour. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => n.toString().padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Local-date stamp as YYYY-MM-DD. */
export function todayStamp(d: Date): string {
	const pad = (n: number) => n.toString().padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Strip characters that are illegal in file names or that anarlog forbids in titles. */
export function sanitizeTitle(raw: string): string {
	return raw
		.replace(/[\*"'`\(\)\[\]\{\}:;\\/<>|?]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Make a string safe as a file name (no path separators or reserved chars). */
export function sanitizeFileName(raw: string): string {
	return (
		raw
			.replace(/[\\/:*?"<>|#\^\[\]]/g, '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 120) || 'Meeting'
	);
}

/** Normalize a free-form tag into a valid, readable Obsidian tag (no spaces). */
export function normalizeTag(raw: string): string {
	return raw
		.replace(/^#+/, '')
		.trim()
		.replace(/\s+/g, '-')
		.replace(/[^A-Za-z0-9_\-/]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Split a reasoning-model response into the answer and the "thinking" (Qwen3
 * `<think>…</think>`, etc.). Handles complete blocks, a dangling open block left by a
 * truncated or still-streaming generation, and an orphan closing tag emitted when a
 * reasoning parser has already consumed the opening `<think>`. Both parts are trimmed.
 */
export function splitReasoning(text: string): { answer: string; reasoning: string } {
	const reasoning: string[] = [];
	let answer = '';
	const blockRe = /<think>([\s\S]*?)<\/think>/gi;
	let lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = blockRe.exec(text)) !== null) {
		answer += text.slice(lastIndex, m.index);
		reasoning.push(m[1]);
		lastIndex = blockRe.lastIndex;
	}
	const tail = text.slice(lastIndex);
	const openIdx = tail.search(/<think>/i);
	const closeIdx = tail.search(/<\/think>/i);
	if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
		// Orphan close: the opening tag was consumed upstream — reasoning up to the close.
		reasoning.push(tail.slice(0, closeIdx));
		answer += tail.slice(closeIdx + '</think>'.length);
	} else if (openIdx !== -1) {
		// Dangling open (truncated or still streaming): everything after it is reasoning.
		answer += tail.slice(0, openIdx);
		reasoning.push(tail.slice(openIdx + '<think>'.length));
	} else {
		answer += tail;
	}
	return { answer: answer.trim(), reasoning: reasoning.join('\n').trim() };
}

/** Remove reasoning-model "thinking" blocks from a response, keeping only the answer. */
export function stripThink(text: string): string {
	return splitReasoning(text).answer;
}

/** How hard a reasoning model should think before answering (OpenAI-style effort ladder). */
export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Map a reasoning level to the extra chat-request params and the token headroom to
 * add on top of a call's answer budget. `off` disables thinking (Qwen3's
 * `enable_thinking:false`); the effort levels enable thinking, pass `reasoning_effort`
 * for servers that honor it, and reserve room so the reasoning never eats the answer.
 * Unknown params are ignored by servers that don't use them, so this is safe to send
 * to any OpenAI-compatible endpoint.
 */
export function reasoningParams(level: ReasoningLevel): { params: Record<string, unknown>; headroom: number } {
	if (level === 'off') {
		return { params: { chat_template_kwargs: { enable_thinking: false } }, headroom: 0 };
	}
	const headroom: Record<Exclude<ReasoningLevel, 'off'>, number> = {
		low: 2048,
		medium: 4096,
		high: 8192,
		xhigh: 16384,
		max: 32768,
	};
	return {
		params: { chat_template_kwargs: { enable_thinking: true }, reasoning_effort: level },
		headroom: headroom[level] ?? 4096,
	};
}

/** Remove a leading ```markdown / ``` fence the model sometimes wraps output in. */
export function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	const fence = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
	return fence ? fence[1].trim() : trimmed;
}

/** Best-effort extraction of a JSON string array from a model response. */
export function parseTagArray(text: string): string[] {
	const attempt = (s: string): string[] | null => {
		try {
			const parsed = JSON.parse(s);
			if (Array.isArray(parsed)) return parsed.map((x) => String(x));
		} catch {
			/* fall through */
		}
		return null;
	};
	let result = attempt(text.trim());
	if (!result) {
		const match = text.match(/\[[\s\S]*?\]/);
		if (match) result = attempt(match[0]);
	}
	if (!result) return [];
	return result;
}

/**
 * Format diarized segments as one line per speaker turn, e.g. `Speaker 1: hello`.
 * Raw diarizer labels (`SPEAKER_00`, `SPEAKER_01`, …) are renamed to `Speaker 1`,
 * `Speaker 2`, … in order of first appearance, and consecutive segments from the
 * same speaker are merged into a single turn.
 */
export function formatDiarizedSegments(segments: any[]): string {
	const labels = new Map<string, string>();
	const label = (raw: string): string => {
		if (!labels.has(raw)) labels.set(raw, `Speaker ${labels.size + 1}`);
		return labels.get(raw) as string;
	};
	const turns: { who: string; text: string }[] = [];
	for (const seg of segments) {
		const text = String(seg?.text ?? '').trim();
		if (!text) continue;
		const who = seg?.speaker ? label(String(seg.speaker)) : 'Unknown speaker';
		const last = turns[turns.length - 1];
		if (last && last.who === who) last.text += ' ' + text;
		else turns.push({ who, text });
	}
	return turns.map((t) => `${t.who}: ${t.text}`).join('\n').trim();
}

/** True if a transcription response body carries any per-segment speaker labels. */
export function responseHasSpeakers(rawText: string): boolean {
	try {
		const data = JSON.parse(rawText);
		return Array.isArray(data.segments) && data.segments.some((s: any) => s && s.speaker);
	} catch {
		return false;
	}
}

/** Parse a transcription API response body into plain text, tolerating many shapes. */
export function parseTranscriptResponse(rawText: string): string {
	let data: any;
	try {
		data = JSON.parse(rawText);
	} catch {
		return rawText.trim();
	}
	if (typeof data === 'string') return data.trim();
	// Speaker-labeled segments (diarization) take priority — otherwise we'd flatten
	// the transcript and lose the "who said what" the diarizer worked to produce.
	if (Array.isArray(data.segments) && data.segments.some((s: any) => s && s.speaker)) {
		return formatDiarizedSegments(data.segments);
	}
	if (data.text) return String(data.text).trim();
	if (Array.isArray(data.segments)) return data.segments.map((s: any) => s.text).join(' ').trim();
	if (data.transcript) return String(data.transcript).trim();
	if (data.results?.channels?.[0]?.alternatives?.[0]?.transcript) {
		return String(data.results.channels[0].alternatives[0].transcript).trim();
	}
	return rawText.trim();
}

/** Quote a value for YAML frontmatter when it contains characters that need it. */
export function yamlString(value: string): string {
	if (/[:#\[\]{}",&*!|>%@`]/.test(value) || /^\s|\s$/.test(value)) {
		return '"' + value.replace(/"/g, '\\"') + '"';
	}
	return value;
}

/** Build an Obsidian callout block, prefixing every line of `content` with `> `. */
export function calloutBlock(type: string, title: string, content: string, collapsed: boolean): string {
	const head = `> [!${type}]${collapsed ? '-' : ''} ${title}`;
	const body = content
		.split('\n')
		.map((line) => (line.length ? `> ${line}` : '>'))
		.join('\n');
	return `${head}\n${body}`;
}

/**
 * Give the summary exactly one top-level heading: `headingText` (the meeting
 * title). If the model emitted its own H1, it's replaced; otherwise one is
 * prepended above the overview. Any *other* H1s in the body are demoted to H2,
 * so there's a single title heading and every section stays `##` or smaller.
 */
export function structureSummary(summary: string, headingText: string): string {
	const lines = summary.replace(/^\s+/, '').split('\n');
	let i = 0;
	while (i < lines.length && lines[i].trim() === '') i++;
	if (i < lines.length && /^#\s+/.test(lines[i])) {
		lines[i] = `# ${headingText}`;
	} else {
		lines.splice(i, 0, `# ${headingText}`, '');
	}
	for (let j = i + 1; j < lines.length; j++) {
		if (/^#\s+/.test(lines[j])) lines[j] = '#' + lines[j];
	}
	return lines.join('\n').trim();
}

/** Build a multipart/form-data body for requestUrl (which has no FormData support). */
export function buildMultipart(
	fields: Record<string, string>,
	file: { field: string; filename: string; type: string; data: ArrayBuffer }
): { body: ArrayBuffer; contentType: string } {
	const boundary = '----Scuttlebutt' + Date.now().toString(16) + Math.floor(Math.random() * 1e9).toString(16);
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const push = (s: string) => chunks.push(enc.encode(s));

	for (const [key, value] of Object.entries(fields)) {
		push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
	}
	push(
		`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
			`Content-Type: ${file.type}\r\n\r\n`
	);
	chunks.push(new Uint8Array(file.data));
	push(`\r\n--${boundary}--\r\n`);

	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}
