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

/** Parse a transcription API response body into plain text, tolerating many shapes. */
export function parseTranscriptResponse(rawText: string): string {
	let data: any;
	try {
		data = JSON.parse(rawText);
	} catch {
		return rawText.trim();
	}
	if (typeof data === 'string') return data.trim();
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
 * Demote any top-level (#) heading in a generated summary to H2, so the note
 * body has no H1 of its own — the note's filename/title serves as the heading,
 * and every section stays `##` or smaller. Prevents a duplicate top heading.
 */
export function demoteH1(summary: string): string {
	return summary
		.split('\n')
		.map((line) => (/^#\s+/.test(line) ? '#' + line : line))
		.join('\n')
		.trim();
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
