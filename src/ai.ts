import { requestUrl } from 'obsidian';
import {
	buildMultipart,
	joinUrl,
	normalizeTag,
	parseTagArray,
	parseTranscriptResponse,
	reasoningParams,
	ReasoningLevel,
	responseHasSpeakers,
	sanitizeTitle,
	splitReasoning,
	stripCodeFences,
	stripThink,
	todayStamp,
	truncate,
} from './utils';
import { ModelOption, ScuttlebuttSettings } from './types';

const TEST_TIMEOUT = 10_000;

// Race a promise against a timeout. `ms <= 0` disables the timeout (wait
// indefinitely) — used when a server's timeout is configured to 0.
/**
 * Milliseconds for a configured timeout (in seconds), guarding a corrupt/blank value.
 * 0 means "wait indefinitely"; anything not a finite number >= 0 falls back to 300s so a
 * bad `data.json` can't turn every request into an instant NaN-timeout failure.
 */
function safeTimeoutMs(seconds: number): number {
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 300_000;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label = 'Request'): Promise<T> {
	if (!ms || ms <= 0) return promise;
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			window.setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
		),
	]);
}

// ---------------------------------------------------------------------------
// Endpoint testing / model discovery
// ---------------------------------------------------------------------------

export interface TestResult {
	ok: boolean;
	message: string;
	models: ModelOption[];
}

export async function testEndpoint(endpoint: string, apiKey: string): Promise<TestResult> {
	if (!endpoint || !endpoint.trim()) {
		return { ok: false, message: 'No endpoint URL set', models: [] };
	}
	try {
		const headers: Record<string, string> = {};
		if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
		const resp = await withTimeout(
			requestUrl({ url: joinUrl(endpoint, 'models'), method: 'GET', headers, throw: false }),
			TEST_TIMEOUT,
			'Test'
		);
		if (resp.status < 200 || resp.status >= 300) {
			return { ok: false, message: `HTTP ${resp.status}: ${truncate(resp.text, 120)}`, models: [] };
		}
		let data: any;
		try {
			data = resp.json;
		} catch {
			return { ok: false, message: 'Endpoint replied but not with JSON — check the URL ends in /v1', models: [] };
		}
		const list: ModelOption[] = (data?.data ?? [])
			.map((m: any) => ({ id: String(m.id), name: String(m.id) }))
			.filter((m: ModelOption) => m.id);
		if (list.length === 0) {
			return { ok: false, message: 'Connected, but the server listed no models', models: [] };
		}
		return { ok: true, message: `${list.length} model${list.length === 1 ? '' : 's'} available`, models: list };
	} catch (err: any) {
		return { ok: false, message: err?.message ?? String(err), models: [] };
	}
}

export class AIService {
	constructor(private settings: ScuttlebuttSettings) {}

	private ensureStt() {
		if (!this.settings.sttEndpoint?.trim()) {
			throw new Error('Transcription endpoint is not set. Open Settings → Scuttlebutt.');
		}
		if (!this.settings.sttModel) {
			throw new Error('No transcription model selected. Test the endpoint in Settings and pick a model.');
		}
	}

	private ensureLlm() {
		if (!this.settings.llmEndpoint?.trim()) {
			throw new Error('Summary endpoint is not set. Open Settings → Scuttlebutt.');
		}
		if (!this.settings.llmModel) {
			throw new Error('No summary model selected. Test the endpoint in Settings and pick a model.');
		}
	}

	/**
	 * POST and return the raw status + body text. Uses `fetch` so the request can be
	 * aborted mid-flight via `signal` (that's the whole point — Obsidian's requestUrl
	 * can't be cancelled). If fetch fails for a reason that ISN'T an abort or timeout —
	 * typically a server that doesn't send CORS headers — it falls back to requestUrl,
	 * which is CORS-immune but uncancellable, so existing setups keep working.
	 */
	private async request(
		url: string,
		headers: Record<string, string>,
		body: ArrayBuffer | string,
		timeoutMs: number,
		label: string,
		signal?: AbortSignal
	): Promise<{ status: number; text: string }> {
		const started = Date.now();
		const controller = new AbortController();
		const onExternalAbort = () => controller.abort();
		if (signal) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener('abort', onExternalAbort, { once: true });
		}
		let timedOut = false;
		const timer =
			timeoutMs > 0
				? window.setTimeout(() => {
						timedOut = true;
						controller.abort();
				  }, timeoutMs)
				: null;
		try {
			const resp = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
			return { status: resp.status, text: await resp.text() };
		} catch (err) {
			if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
			if (timedOut) throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
			// Not an abort and not a timeout — most often a CORS/network failure. Retry
			// through requestUrl (no CORS check, but no cancellation either).
			// Don't re-arm a fresh full timeout on the fallback leg — cap it at what's left,
			// so the worst-case wait is ~1x the setting, not 2x.
			const remaining = timeoutMs > 0 ? Math.max(1000, timeoutMs - (Date.now() - started)) : timeoutMs;
			const resp = await withTimeout(
				requestUrl({ url, method: 'POST', headers, body, throw: false }),
				remaining,
				label
			);
			return { status: resp.status, text: resp.text };
		} finally {
			if (timer !== null) window.clearTimeout(timer);
			if (signal) signal.removeEventListener('abort', onExternalAbort);
		}
	}

	async transcribe(
		data: ArrayBuffer,
		filename: string,
		mime: string,
		diarize: boolean,
		signal?: AbortSignal
	): Promise<{ text: string; hasSpeakers: boolean }> {
		this.ensureStt();
		const fields: Record<string, string> = { model: this.settings.sttModel };
		const lang = this.settings.sttLanguage?.trim();
		if (lang && lang.toLowerCase() !== 'auto') fields.language = lang;
		// Ask the endpoint to identify speakers. A diarizing server (e.g. the bundled
		// WhisperX one) returns per-segment speaker labels, which parseTranscriptResponse
		// renders as turns. Most other servers ignore `diarize`; `verbose_json` is the
		// one field a few endpoints reject, which is why the caller can retry without it.
		if (diarize) {
			fields.diarize = 'true';
			fields.response_format = 'verbose_json';
		}

		const { body, contentType } = buildMultipart(fields, { field: 'file', filename, type: mime, data });
		const headers: Record<string, string> = { 'Content-Type': contentType };
		if (this.settings.sttApiKey) headers['Authorization'] = 'Bearer ' + this.settings.sttApiKey;

		const resp = await this.request(
			joinUrl(this.settings.sttEndpoint, 'audio/transcriptions'),
			headers,
			body,
			safeTimeoutMs(this.settings.sttTimeout),
			'Transcription',
			signal
		);
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`Transcription failed (HTTP ${resp.status}): ${truncate(resp.text, 200)}`);
		}
		return { text: parseTranscriptResponse(resp.text), hasSpeakers: responseHasSpeakers(resp.text) };
	}

	/** Reasoning params + JSON headers + budget for a chat call. Shared by all chat paths. */
	private chatEnvelope(maxTokens: number, reasoning?: ReasoningLevel) {
		this.ensureLlm();
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.settings.llmApiKey) headers['Authorization'] = 'Bearer ' + this.settings.llmApiKey;
		// Reasoning models (e.g. Qwen3) emit a <think> block that eats the token budget.
		// `reasoningParams` disables thinking when off, and otherwise reserves headroom so
		// the reasoning never starves the answer — critical for the tiny title/tag budgets.
		// A per-run level (from the sidebar) overrides the global setting when given.
		const { params, headroom } = reasoningParams(reasoning ?? this.settings.reasoningEffort ?? 'off');
		return { url: joinUrl(this.settings.llmEndpoint, 'chat/completions'), headers, params, maxTokens: maxTokens + headroom };
	}

	/** One-shot chat completion. Returns the raw answer content and any separate reasoning. */
	private async chatRaw(
		system: string,
		user: string,
		maxTokens: number,
		temperature: number,
		signal?: AbortSignal,
		reasoning?: ReasoningLevel
	): Promise<{ content: string; reasoning: string }> {
		const env = this.chatEnvelope(maxTokens, reasoning);
		const resp = await this.request(
			env.url,
			env.headers,
			JSON.stringify({
				model: this.settings.llmModel,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user },
				],
				max_tokens: env.maxTokens,
				temperature,
				...env.params,
			}),
			safeTimeoutMs(this.settings.llmTimeout),
			'Summary',
			signal
		);
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`LLM request failed (HTTP ${resp.status}): ${truncate(resp.text, 200)}`);
		}
		let data: any;
		try {
			data = JSON.parse(resp.text);
		} catch {
			throw new Error('LLM endpoint returned a non-JSON response.');
		}
		const msg = data.choices?.[0]?.message ?? {};
		const content = String(msg.content ?? data.choices?.[0]?.text ?? '');
		const reasoningField = String(msg.reasoning_content ?? msg.reasoning ?? '');
		return { content, reasoning: reasoningField };
	}

	/** One-shot chat that returns only the answer (thinking stripped). For title/tags. */
	private async chat(
		system: string,
		user: string,
		maxTokens: number,
		temperature: number,
		signal?: AbortSignal,
		reasoning?: ReasoningLevel
	): Promise<string> {
		const raw = await this.chatRaw(system, user, maxTokens, temperature, signal, reasoning);
		return stripThink(raw.content);
	}

	/**
	 * Streaming chat completion (SSE). Calls `onDelta(answer, reasoning)` as tokens arrive,
	 * routing `<think>` / `reasoning_content` into the reasoning stream and the rest into the
	 * answer. Uses fetch, so it can't fall back to requestUrl — the caller falls back to a
	 * one-shot request on a non-abort/timeout failure (e.g. a server without CORS).
	 */
	private async chatStream(
		system: string,
		user: string,
		maxTokens: number,
		temperature: number,
		onDelta: (answer: string, reasoning: string) => void,
		signal?: AbortSignal,
		reasoning?: ReasoningLevel
	): Promise<{ answer: string; reasoning: string }> {
		const env = this.chatEnvelope(maxTokens, reasoning);
		const headers = { ...env.headers, Accept: 'text/event-stream' };
		const controller = new AbortController();
		const onExternalAbort = () => controller.abort();
		if (signal) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener('abort', onExternalAbort, { once: true });
		}
		const timeoutMs = safeTimeoutMs(this.settings.llmTimeout);
		let timedOut = false;
		// Idle timeout: reset on every chunk so a healthy (but slow) stream is never cut;
		// only a genuine stall — no token for the whole window — aborts it.
		let timer: number | null = null;
		const arm = () => {
			if (timeoutMs <= 0) return;
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);
		};
		arm();

		let contentRaw = '';
		let reasoningField = '';
		const combined = () => {
			const split = splitReasoning(contentRaw);
			const reasoning = [reasoningField.trim(), split.reasoning].filter(Boolean).join('\n').trim();
			return { answer: split.answer, reasoning };
		};

		try {
			const resp = await fetch(env.url, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					model: this.settings.llmModel,
					messages: [
						{ role: 'system', content: system },
						{ role: 'user', content: user },
					],
					max_tokens: env.maxTokens,
					temperature,
					stream: true,
					...env.params,
				}),
				signal: controller.signal,
			});
			if (!resp.ok) {
				const errText = await resp.text().catch(() => '');
				throw new Error(`LLM request failed (HTTP ${resp.status}): ${truncate(errText, 200)}`);
			}
			if (!resp.body) throw new Error('Streaming not supported by this response.');

			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				arm(); // healthy stream: reset the idle timer on every chunk
				buffer += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, nl).replace(/\r$/, '').trim();
					buffer = buffer.slice(nl + 1);
					if (!line.startsWith('data:')) continue;
					const data = line.slice(5).trim();
					if (data === '[DONE]') continue;
					try {
						const json = JSON.parse(data);
						const delta = json.choices?.[0]?.delta ?? {};
						if (typeof delta.content === 'string') contentRaw += delta.content;
						if (typeof delta.reasoning_content === 'string') reasoningField += delta.reasoning_content;
						else if (typeof delta.reasoning === 'string') reasoningField += delta.reasoning;
					} catch {
						/* keep-alive or partial JSON — ignore */
					}
				}
				const c = combined();
				onDelta(c.answer, c.reasoning);
			}
			const c = combined();
			// A server that ignored `stream:true` sends no SSE `data:` lines, leaving us with
			// nothing — signal the caller to fall back to a one-shot request.
			if (!c.answer && !c.reasoning) throw new Error('No streamed content received.');
			onDelta(c.answer, c.reasoning);
			return c;
		} catch (err: any) {
			if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
			if (timedOut) throw new Error(`Summary timed out after ${Math.round(timeoutMs / 1000)}s`);
			throw err;
		} finally {
			if (timer !== null) window.clearTimeout(timer);
			if (signal) signal.removeEventListener('abort', onExternalAbort);
		}
	}

	async summarize(
		input: {
			transcript: string;
			memo: string;
			participants: string;
			contextDocs: { path: string; content: string }[];
		},
		opts: {
			signal?: AbortSignal;
			reasoning?: ReasoningLevel;
			/** When given, stream the summary and call this as tokens arrive. */
			onDelta?: (answer: string, reasoning: string) => void;
		} = {}
	): Promise<{ summary: string; reasoning: string }> {
		const system = this.settings.summaryPrompt.replace(/\{\{\s*language\s*\}\}/g, this.settings.language || 'English');
		const parts: string[] = [];
		parts.push('# Context');
		parts.push(`Current date: ${todayStamp(new Date())}`);
		if (input.participants.trim()) parts.push(`Participants: ${input.participants.trim()}`);

		if (input.contextDocs.length > 0) {
			parts.push('\n# Reference Notes');
			for (const doc of input.contextDocs) {
				parts.push(`\n## ${doc.path}\n${doc.content.trim()}`);
			}
		}
		if (input.memo.trim()) {
			parts.push('\n# Meeting Notes (Memo)');
			parts.push(input.memo.trim());
		}
		parts.push('\n# Transcript');
		parts.push(input.transcript.trim() || '(empty)');
		const user = parts.join('\n');

		if (opts.onDelta) {
			try {
				const r = await this.chatStream(system, user, 8192, 0.3, opts.onDelta, opts.signal, opts.reasoning);
				return { summary: stripCodeFences(r.answer), reasoning: r.reasoning };
			} catch (err: any) {
				// A cancel or timeout is terminal; anything else (e.g. a server without CORS
				// that can't stream over fetch) falls back to a one-shot request.
				if (err?.name === 'AbortError' || opts.signal?.aborted) throw err;
				if (/timed out/i.test(err?.message ?? '')) throw err;
				console.warn('Scuttlebutt: streaming failed, falling back to a one-shot request', err);
			}
		}
		const raw = await this.chatRaw(system, user, 8192, 0.3, opts.signal, opts.reasoning);
		const split = splitReasoning(raw.content);
		const reasoning = [raw.reasoning.trim(), split.reasoning].filter(Boolean).join('\n').trim();
		return { summary: stripCodeFences(split.answer), reasoning };
	}

	async generateTitle(content: string, signal?: AbortSignal, reasoning?: ReasoningLevel): Promise<string> {
		const language = this.settings.language || 'English';
		const system =
			`Current date: ${todayStamp(new Date())}\n\n` +
			`You are a professional assistant that generates a perfect title for a meeting note, in ${language}.\n\n` +
			`# Format Requirements\n` +
			`- Only output the title as plaintext, nothing else. No characters like *"'([{}]):.\n` +
			`- Never ask questions or request more information.\n` +
			`- If the note is empty or has no meaningful content, output exactly: <EMPTY>`;
		const user = `<note>\n${content}\n</note>\n\nNow, give me a SUPER CONCISE title for the above note. Only about the topic of the meeting.`;
		const out = (await this.chat(system, user, 64, 0.3, signal, reasoning)).trim();
		if (!out || out === '<EMPTY>') return '';
		return sanitizeTitle(out);
	}

	async generateTags(
		title: string,
		content: string,
		historicalTags: string[],
		signal?: AbortSignal,
		reasoning?: ReasoningLevel
	): Promise<string[]> {
		const defaults = this.settings.defaultTags.join(', ');
		const system =
			`You are an intelligent tagging assistant. Suggest 3–5 concise, specific tags for a meeting note.\n\n` +
			`## How to choose (in this order)\n` +
			`1. FIRST review the user's existing vault tags (listed in the prompt). Reuse any that genuinely fit the content, and return them EXACTLY as written — same spelling and case.\n` +
			`2. Only for aspects no existing tag covers, consider these defaults: [${defaults}].\n` +
			`3. Only invent a brand-new tag when neither an existing tag nor a default fits.\n\n` +
			`## Rules\n` +
			`- Return 3 to 5 tags total.\n` +
			`- Prefer an existing tag over a near-duplicate (e.g. do not add "planning" if "Planning" already exists).\n` +
			`- Avoid generic tags like "note", "meeting", or "content".\n` +
			`- Make tags specific: people, projects, tools, concepts, workflows.\n\n` +
			`## Response Format\n` +
			`Return ONLY a JSON array of strings, nothing else. Example: ["Engineering", "project-alpha"]`;
		const existing =
			historicalTags.length > 0
				? `## Existing tags in the vault (reuse these when they fit)\n${historicalTags.join(', ')}\n\n`
				: '## Existing tags in the vault\n(none yet)\n\n';
		const user = `${existing}## Note\n\n**Title:** ${title || '(untitled)'}\n\n**Content:**\n${content}`;
		const out = await this.chat(system, user, 128, 0.4, signal, reasoning);
		const tags = parseTagArray(out)
			.map(normalizeTag)
			.filter((t) => t.length > 0);
		// de-dupe preserving order, cap at 5
		const seen = new Set<string>();
		const unique: string[] = [];
		for (const t of tags) {
			const key = t.toLowerCase();
			if (!seen.has(key)) {
				seen.add(key);
				unique.push(t);
			}
			if (unique.length >= 5) break;
		}
		return unique;
	}
}
