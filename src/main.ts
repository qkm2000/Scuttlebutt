/*
 * Scuttlebutt — an Obsidian plugin
 *
 * A local-first meeting companion that lives in your sidebar (inspired by anarlog):
 * record (or import) a meeting, transcribe it against your local Whisper/vLLM
 * server, auto-summarize it with your local LLM, review the Summary / Transcript /
 * Memo side-by-side, then save a single tidy note with a clean title and tags.
 *
 * Pipeline:  record | import  ->  transcribe  ->  summarize (+ title + tags)  ->  review  ->  save note
 *
 * Local-first. Everything runs against endpoints you configure. No cloud, no accounts.
 */

import {
	App,
	Component,
	DropdownComponent,
	FuzzySuggestModal,
	ItemView,
	MarkdownRenderer,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TextAreaComponent,
	TextComponent,
	TFile,
	WorkspaceLeaf,
	moment,
	normalizePath,
	requestUrl,
	setIcon,
} from 'obsidian';

// Obsidian re-exports `moment` as a callable at runtime, but its bundled type is the
// namespace (no call signature), so `tsc` rejects `moment(...)`. Alias to the call form.
const mmt = moment as unknown as (inp?: string | number | Date) => { format(fmt: string): string };
import {
	buildMultipart,
	calloutBlock,
	formatDuration,
	joinUrl,
	normalizeTag,
	parseTagArray,
	parseTranscriptResponse,
	reasoningParams,
	ReasoningLevel,
	recordedMs,
	responseHasSpeakers,
	sanitizeFileName,
	sanitizeTitle,
	splitReasoning,
	stripCodeFences,
	stripThink,
	structureSummary,
	todayStamp,
	truncate,
	yamlString,
} from './utils';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface ModelOption {
	id: string;
	name: string;
}

/** A cached audio input device, persisted so the picker survives a reload without re-detecting. */
interface AudioInput {
	deviceId: string;
	label: string;
}

interface ScuttlebuttSettings {
	// Transcription endpoint (Whisper / vLLM)
	sttEndpoint: string;
	sttApiKey: string;
	sttModel: string;
	sttModels: ModelOption[];
	sttLanguage: string;
	sttDiarize: boolean;
	sttTimeout: number; // seconds; 0 = wait indefinitely

	// Summary endpoint (LLM / vLLM)
	llmEndpoint: string;
	llmApiKey: string;
	llmModel: string;
	llmModels: ModelOption[];
	llmTimeout: number; // seconds; 0 = wait indefinitely
	reasoningEffort: ReasoningLevel; // 'off' disables model thinking; effort levels enable it
	streamSummary: boolean; // stream the summary token-by-token into the review pane

	// Prompts / language
	summaryPrompt: string;
	language: string;

	// Capture
	captureSystemAudio: boolean;
	inputDeviceId: string;
	systemAudioDeviceId: string; // optional loopback input mixed in alongside the mic
	audioDevices: AudioInput[]; // cached device list so the pickers survive a reload

	// Output
	notesFolder: string;
	audioFolder: string;
	dateFormat: string;
	saveAudio: boolean;
	includeTranscript: boolean;
	includeMemo: boolean;
	autoSummarize: boolean;
	autoOpenNote: boolean;
	generateTags: boolean;
	generateTitle: boolean;
	defaultTags: string[];
}

const DEFAULT_DATE_FORMAT = 'dddd, MMMM Do YYYY, h:mm:ss a';

const DEFAULT_SUMMARY_PROMPT = `# General Instructions

You are an expert at creating structured, comprehensive meeting summaries in {{language}}. Maintain accuracy, completeness, and professional terminology.

# Output Structure

- Write a short overview first: a 2–4 sentence paragraph (no heading of its own) summarizing the whole meeting — its purpose, key outcomes, and decisions. This overview is required.
- After the overview, organize the details into sections, each introduced by a second-level ("##") heading (use "###" only for sub-points).
- Do NOT write your own first-level ("#") heading — a single title heading is added for you automatically. Every heading you write must be "##" or smaller.
- Under each section, use bullet points for specific discussion details, decisions, and key points.
- Include a "## Action items" section when there are any, noting owners where known.

# Format Requirements

- Use Markdown without code block wrappers.
- Keep bullets concrete and specific; avoid nesting beyond one level of indentation.
- Your final output MUST be ONLY the markdown summary itself — no preamble, no commentary, no "Here's the summary".

# Guidelines

- Notes and transcript may contain errors made by humans and speech-to-text respectively. Make the best of every material.
- Do not restate the meeting title or attendee lists as body content.
- Use the reference notes and memo to understand intent and agenda; weave them into the relevant sections.
- Preserve essential details; keep content concrete and specific.`;

const DEFAULT_SETTINGS: ScuttlebuttSettings = {
	sttEndpoint: 'http://localhost:8000/v1',
	sttApiKey: '',
	sttModel: '',
	sttModels: [],
	sttLanguage: 'en',
	sttDiarize: false,
	sttTimeout: 300,

	llmEndpoint: 'http://localhost:8000/v1',
	llmApiKey: '',
	llmModel: '',
	llmModels: [],
	llmTimeout: 300,
	reasoningEffort: 'off',
	streamSummary: true,

	summaryPrompt: DEFAULT_SUMMARY_PROMPT,
	language: 'English',

	captureSystemAudio: false,
	inputDeviceId: '',
	systemAudioDeviceId: '',
	audioDevices: [],

	notesFolder: 'Scuttlebutt/Notes',
	audioFolder: 'Scuttlebutt/Audio',
	dateFormat: DEFAULT_DATE_FORMAT,
	saveAudio: true,
	includeTranscript: true,
	includeMemo: true,
	autoSummarize: true,
	autoOpenNote: false,
	generateTags: true,
	generateTitle: true,
	defaultTags: [
		'Sales',
		'User-Interview',
		'Product',
		'Marketing',
		'Engineering',
		'Customer-Support',
		'Research',
		'Insight',
		'Design',
		'Recruiting',
	],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const TEST_TIMEOUT = 10_000;

// Race a promise against a timeout. `ms <= 0` disables the timeout (wait
// indefinitely) — used when a server's timeout is configured to 0.
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

interface TestResult {
	ok: boolean;
	message: string;
	models: ModelOption[];
}

async function testEndpoint(endpoint: string, apiKey: string): Promise<TestResult> {
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

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

class MeetingRecorder {
	private mediaRecorder: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private sources: MediaStream[] = [];
	private audioContext: AudioContext | null = null;
	private chunks: Blob[] = [];
	private mimeType = 'audio/webm';
	private starting = false;

	isRecording(): boolean {
		return this.mediaRecorder?.state === 'recording';
	}

	isPaused(): boolean {
		return this.mediaRecorder?.state === 'paused';
	}

	/** True while a recording exists and is either capturing or paused. */
	isActive(): boolean {
		const st = this.mediaRecorder?.state;
		return st === 'recording' || st === 'paused';
	}

	pause(): void {
		if (this.mediaRecorder?.state === 'recording') this.mediaRecorder.pause();
	}

	resume(): void {
		if (this.mediaRecorder?.state === 'paused') this.mediaRecorder.resume();
	}

	async start(opts: {
		inputDeviceId?: string;
		systemAudioDeviceId?: string;
		captureSystemAudio: boolean;
	}): Promise<{ systemAudio: boolean }> {
		// A re-entrant start (double-click, ribbon + command) is a no-op — otherwise the
		// second call orphans the first mic MediaStream, leaving the mic captured.
		if (this.starting || this.isRecording()) return { systemAudio: false };
		this.starting = true;
		try {
		// Microphone — the base track. Mic processing (echo cancellation, noise
		// suppression) is on; a system/loopback source below is captured raw so that
		// processing doesn't gate it.
		const micConstraints: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
		if (opts.inputDeviceId) micConstraints.deviceId = { exact: opts.inputDeviceId };
		const micStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: micConstraints });
		this.sources = [micStream];
		let systemAudio = false;

		// System audio as a second *input* device (e.g. a BlackHole/aggregate loopback
		// on macOS). This is the reliable way to capture system/meeting audio; it's
		// mixed with the mic into one track.
		if (opts.systemAudioDeviceId && opts.systemAudioDeviceId !== opts.inputDeviceId) {
			try {
				const sysStream = await navigator.mediaDevices.getUserMedia({
					video: false,
					audio: { deviceId: { exact: opts.systemAudioDeviceId } },
				});
				this.sources.push(sysStream);
				systemAudio = true;
			} catch {
				/* device unavailable — degrade to whatever else we have */
			}
		}

		// System audio via a screen-share prompt (works on some platforms, not reliably
		// on macOS). Kept as an alternative to the loopback-device route above.
		if (opts.captureSystemAudio) {
			try {
				const screen = await navigator.mediaDevices
					.getDisplayMedia({ video: true, audio: true })
					.catch(() => null);
				if (screen) {
					if (screen.getAudioTracks().length > 0) {
						this.sources.push(new MediaStream(screen.getAudioTracks()));
						systemAudio = true;
					}
					screen.getVideoTracks().forEach((t) => t.stop());
				}
			} catch {
				/* ignore — degrade gracefully */
			}
		}

		// A single source records directly; multiple sources are mixed into one track.
		this.stream = this.sources.length > 1 ? this.mix(this.sources) : micStream;

		const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
		this.mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'audio/webm';

		this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });
		this.chunks = [];
		this.mediaRecorder.ondataavailable = (e) => {
			if (e.data && e.data.size > 0) this.chunks.push(e.data);
		};
		this.mediaRecorder.start(1000);
		return { systemAudio };
		} catch (err) {
			// A failure after getUserMedia (e.g. the MediaRecorder ctor throwing) must not
			// leave mic/loopback tracks or the AudioContext open.
			this.cleanup();
			throw err;
		} finally {
			this.starting = false;
		}
	}

	/** Mix several audio streams down to a single MediaStream via the Web Audio graph. */
	private mix(streams: MediaStream[]): MediaStream {
		this.audioContext = new AudioContext();
		const dest = this.audioContext.createMediaStreamDestination();
		for (const s of streams) {
			for (const track of s.getAudioTracks()) {
				this.audioContext.createMediaStreamSource(new MediaStream([track])).connect(dest);
			}
		}
		return dest.stream;
	}

	stop(): Promise<Blob> {
		return new Promise((resolve) => {
			if (!this.mediaRecorder) {
				resolve(new Blob());
				return;
			}
			this.mediaRecorder.onstop = () => {
				const blob = new Blob(this.chunks, { type: this.mimeType });
				this.cleanup();
				resolve(blob);
			};
			this.mediaRecorder.stop();
		});
	}

	getMimeType(): string {
		return this.mimeType;
	}

	private cleanup() {
		// Stop every raw source (mic + any system/loopback + display) as well as the
		// final (possibly mixed) stream, so no device is left in use.
		for (const s of this.sources) {
			for (const track of s.getTracks()) track.stop();
		}
		this.sources = [];
		if (this.stream) {
			for (const track of this.stream.getTracks()) track.stop();
			this.stream = null;
		}
		if (this.audioContext) {
			this.audioContext.close().catch(() => {});
			this.audioContext = null;
		}
		this.mediaRecorder = null;
		this.chunks = [];
	}

	abort() {
		if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
			try {
				this.mediaRecorder.stop();
			} catch {
				/* ignore */
			}
		}
		this.cleanup();
	}
}

// ---------------------------------------------------------------------------
// AI services (transcribe / summarize / title / tags)
// ---------------------------------------------------------------------------

class AIService {
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
			const resp = await withTimeout(
				requestUrl({ url, method: 'POST', headers, body, throw: false }),
				timeoutMs,
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
			this.settings.sttTimeout * 1000,
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
			this.settings.llmTimeout * 1000,
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
		const timeoutMs = this.settings.llmTimeout * 1000;
		let timedOut = false;
		const timer =
			timeoutMs > 0
				? window.setTimeout(() => {
						timedOut = true;
						controller.abort();
				  }, timeoutMs)
				: null;

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

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

type SessionStatus =
	| 'idle'
	| 'recording'
	| 'recorded'
	| 'transcribing'
	| 'summarizing'
	| 'ready'
	| 'saving'
	| 'error';

type ReviewTab = 'summary' | 'transcript' | 'memo';

interface MeetingSession {
	status: SessionStatus;
	audioData: ArrayBuffer | null;
	audioMime: string;
	audioName: string;
	audioSourcePath: string | null; // set when imported from an existing vault file
	transcript: string;
	memo: string;
	participants: string[];
	contextFiles: string[];
	diarize: boolean; // per-recording speaker identification (defaults from settings)
	reasoningEffort: ReasoningLevel; // per-run LLM thinking level (defaults from settings)
	stream: boolean; // per-run: stream the summary as it generates (defaults from settings)
	reasoning: string; // captured model "thinking" for the summary, shown in review only
	summary: string;
	title: string;
	tags: string[];
	paused: boolean; // true while a recording is paused; drives the "Paused" display only
	activeMs: number; // recorded ms banked from completed (pre-pause) segments
	segmentStartedAt: number | null; // start of the current active segment; null while paused / not recording
	elapsedMs: number;
	error: string | null;
	activeTab: ReviewTab;
	previewSummary: boolean;
	progressLabel: string;
	progressPct: number;
	savedNotePath: string | null;
}

function newSession(
	diarizeDefault = false,
	reasoningDefault: ReasoningLevel = 'off',
	streamDefault = true
): MeetingSession {
	return {
		status: 'idle',
		audioData: null,
		audioMime: 'audio/webm',
		audioName: '',
		audioSourcePath: null,
		transcript: '',
		memo: '',
		participants: [],
		contextFiles: [],
		diarize: diarizeDefault,
		reasoningEffort: reasoningDefault,
		stream: streamDefault,
		reasoning: '',
		summary: '',
		title: '',
		tags: [],
		paused: false,
		activeMs: 0,
		segmentStartedAt: null,
		elapsedMs: 0,
		error: null,
		activeTab: 'summary',
		previewSummary: false,
		progressLabel: '',
		progressPct: 0,
		savedNotePath: null,
	};
}

// ---------------------------------------------------------------------------
// Fuzzy pickers
// ---------------------------------------------------------------------------

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private message: string,
		private confirmLabel: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl('p', { text: this.message });
		const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const confirm = row.createEl('button', { cls: 'mod-warning', text: this.confirmLabel });
		confirm.onclick = () => {
			this.close();
			this.onConfirm();
		};
		const cancel = row.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class SaveChoiceModal extends Modal {
	constructor(
		app: App,
		private existingPath: string,
		private onReplace: () => void,
		private onNew: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl('p', { text: `A note already exists at "${this.existingPath}".` });
		const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const replace = row.createEl('button', { cls: 'mod-cta', text: 'Replace' });
		replace.onclick = () => {
			this.close();
			this.onReplace();
		};
		const asNew = row.createEl('button', { text: 'New file' });
		asNew.onclick = () => {
			this.close();
			this.onNew();
		};
		const cancel = row.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class FileSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private files: TFile[],
		private onPick: (file: TFile) => void,
		placeholder: string
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}
	getItems(): TFile[] {
		return this.files;
	}
	getItemText(file: TFile): string {
		return file.path;
	}
	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}

// ---------------------------------------------------------------------------
// Sidebar view
// ---------------------------------------------------------------------------

const VIEW_TYPE_SCUTTLEBUTT = 'scuttlebutt-view';
const AUDIO_EXTENSIONS = ['webm', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'mp4', 'mpga', 'oga'];

class ScuttlebuttView extends ItemView {
	private timer: number | null = null;
	private timerEl: HTMLElement | null = null;
	private audioUrl: string | null = null;
	// Disclosure state, kept across re-renders (both collapsed by default).
	private runOptionsOpen = false;
	private reasoningOpen = false;
	// Live targets for a streaming summary, updated in place without a full re-render.
	private streamSummaryEl: HTMLTextAreaElement | null = null;
	private streamReasoningEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: ScuttlebuttPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_SCUTTLEBUTT;
	}
	getDisplayText(): string {
		return 'Scuttlebutt';
	}
	getIcon(): string {
		return 'mic';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		this.stopTimer();
		this.revokeAudioUrl();
		this.contentEl.empty();
	}

	private revokeAudioUrl(): void {
		if (this.audioUrl) {
			URL.revokeObjectURL(this.audioUrl);
			this.audioUrl = null;
		}
	}

	private get s(): MeetingSession {
		return this.plugin.session;
	}

	updateTimer(): void {
		if (this.timerEl) {
			this.timerEl.setText(formatDuration(recordedMs(this.s.activeMs, this.s.segmentStartedAt, Date.now())));
		}
	}

	private startTimer(): void {
		if (this.timer !== null) return;
		this.timer = window.setInterval(() => this.updateTimer(), 1000);
		this.registerInterval(this.timer);
	}

	private stopTimer(): void {
		if (this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
	}

	// ---- rendering -------------------------------------------------------

	render(): void {
		this.stopTimer();
		this.revokeAudioUrl();
		this.timerEl = null;
		this.streamSummaryEl = null;
		this.streamReasoningEl = null;
		const root = this.contentEl;
		root.empty();
		root.addClass('mh-root');

		this.renderHeader(root);
		this.renderCapture(root);

		const s = this.s;
		const hasContent = !!(s.audioData || s.transcript || s.summary);
		if (hasContent || s.status !== 'idle') {
			this.renderMeta(root);
			this.renderContext(root);
			this.renderReview(root);
			this.renderActions(root);
		} else {
			this.renderEmpty(root);
		}

		this.renderProgress(root);

		if (s.status === 'recording') this.startTimer();
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv('mh-header');
		const brand = header.createDiv('mh-brand');
		setIcon(brand.createSpan('mh-brand-icon'), 'mic');
		brand.createSpan({ text: 'Scuttlebutt', cls: 'mh-brand-title' });

		const pill = header.createDiv({ cls: ['mh-pill', `mh-pill-${this.statusTone()}`] });
		pill.createSpan('mh-pill-dot');
		pill.createSpan({ text: this.statusLabel() });
	}

	private statusTone(): string {
		if (this.s.paused) return 'paused';
		switch (this.s.status) {
			case 'recording':
				return 'rec';
			case 'transcribing':
			case 'summarizing':
			case 'saving':
				return 'busy';
			case 'ready':
				return 'ok';
			case 'error':
				return 'err';
			default:
				return 'idle';
		}
	}

	private statusLabel(): string {
		if (this.s.paused) return 'Paused';
		switch (this.s.status) {
			case 'recording':
				return 'Recording';
			case 'recorded':
				return 'Recorded';
			case 'transcribing':
				return 'Transcribing';
			case 'summarizing':
				return 'Summarizing';
			case 'ready':
				return 'Ready';
			case 'saving':
				return 'Saving';
			case 'error':
				return 'Error';
			default:
				return 'Idle';
		}
	}

	private renderCapture(root: HTMLElement): void {
		const s = this.s;
		const card = root.createDiv('mh-capture');
		const recording = s.status === 'recording';

		const busy = s.status === 'transcribing' || s.status === 'summarizing' || s.status === 'saving';
		if (recording) {
			const live = card.createDiv({ cls: ['mh-record-live', s.paused ? 'is-paused' : 'is-recording'] });

			const display = live.createDiv('mh-record-display');
			const eq = display.createDiv({ cls: ['mh-eq', s.paused ? 'is-paused' : ''] });
			for (let i = 0; i < 4; i++) eq.createSpan('mh-eq-bar');
			this.timerEl = display.createSpan({
				cls: 'mh-timer',
				text: formatDuration(recordedMs(s.activeMs, s.segmentStartedAt, Date.now())),
			});
			if (s.paused) display.createSpan({ cls: 'mh-timer-note', text: 'paused' });

			const actions = live.createDiv('mh-record-actions');
			const pauseBtn = actions.createEl('button', { cls: 'mh-pause-btn' });
			setIcon(pauseBtn.createSpan('mh-record-icon'), s.paused ? 'play' : 'pause');
			pauseBtn.createSpan({ text: s.paused ? 'Resume' : 'Pause' });
			pauseBtn.disabled = busy;
			pauseBtn.onclick = () => this.plugin.togglePause();

			const stopBtn = actions.createEl('button', { cls: 'mh-stop-btn' });
			setIcon(stopBtn.createSpan('mh-record-icon'), 'square');
			stopBtn.createSpan({ text: 'Stop' });
			stopBtn.disabled = busy;
			stopBtn.onclick = () => this.plugin.stopRecording();
		} else {
			const recordBtn = card.createEl('button', { cls: 'mh-record-btn' });
			setIcon(recordBtn.createSpan('mh-record-icon'), 'mic');
			recordBtn.createSpan({ text: 'Start recording', cls: 'mh-record-label' });
			recordBtn.disabled = busy;
			recordBtn.onclick = () => this.plugin.toggleRecording();
		}

		const importRow = card.createDiv('mh-import-row');
		const vaultBtn = importRow.createEl('button', { cls: 'mh-ghost-btn' });
		setIcon(vaultBtn.createSpan('mh-ghost-icon'), 'folder-open');
		vaultBtn.createSpan({ text: 'From vault' });
		vaultBtn.disabled = recording || busy;
		vaultBtn.onclick = () => this.pickAudioFromVault();

		const diskBtn = importRow.createEl('button', { cls: 'mh-ghost-btn' });
		setIcon(diskBtn.createSpan('mh-ghost-icon'), 'upload');
		diskBtn.createSpan({ text: 'Upload' });
		diskBtn.disabled = recording || busy;
		diskBtn.onclick = () => this.uploadAudioFromDisk();

		this.renderRunOptions(card, recording || busy);

		if (s.audioName && s.status !== 'recording') {
			const clip = card.createDiv('mh-clip');
			setIcon(clip.createSpan('mh-clip-icon'), 'audio-file');
			clip.createSpan({ text: s.audioName, cls: 'mh-clip-name' });
			if (s.status === 'recorded' || s.status === 'error') {
				const proc = clip.createEl('button', { cls: 'mh-clip-action', text: 'Transcribe' });
				proc.onclick = () => this.plugin.runPipeline();
			}

			if (s.audioData) {
				const player = card.createEl('audio', { cls: 'mh-audio', attr: { controls: 'true' } });
				this.audioUrl = URL.createObjectURL(new Blob([s.audioData], { type: s.audioMime }));
				player.src = this.audioUrl;
			}
		}
	}

	/**
	 * Collapsible per-recording run options (speakers · thinking · streaming).
	 * A new session (from "New", a recording, or an import) seeds these from the global
	 * settings; after that they stick until the next "New", so choices made here aren't lost
	 * when a recording starts. The disclosure is collapsed by default.
	 */
	private renderRunOptions(card: HTMLElement, disabled: boolean): void {
		const s = this.s;

		const det = card.createEl('details', { cls: 'mh-runopts' });
		det.open = this.runOptionsOpen;
		det.ontoggle = () => {
			this.runOptionsOpen = det.open;
		};
		const summary = det.createEl('summary', { cls: 'mh-runopts-summary' });
		setIcon(summary.createSpan('mh-diar-icon'), 'sliders-horizontal');
		summary.createSpan({ text: 'Run options' });

		const bodyEl = det.createDiv('mh-runopts-body');

		// Checkboxes grouped together.
		const checks = bodyEl.createDiv('mh-runopts-group');

		const diarToggle = checks.createEl('label', { cls: 'mh-diar' });
		const diarCb = diarToggle.createEl('input', { attr: { type: 'checkbox' } });
		diarCb.checked = s.diarize;
		diarCb.disabled = disabled;
		setIcon(diarToggle.createSpan('mh-diar-icon'), 'users');
		diarToggle.createSpan({ text: 'Identify speakers' });
		diarCb.onchange = () => {
			s.diarize = diarCb.checked;
		};

		const streamToggle = checks.createEl('label', { cls: 'mh-diar' });
		const streamCb = streamToggle.createEl('input', { attr: { type: 'checkbox' } });
		streamCb.checked = s.stream;
		streamCb.disabled = disabled;
		setIcon(streamToggle.createSpan('mh-diar-icon'), 'zap');
		streamToggle.createSpan({ text: 'Stream summary' });
		streamCb.onchange = () => {
			s.stream = streamCb.checked;
		};

		// Dropdowns grouped together.
		const selects = bodyEl.createDiv('mh-runopts-group');

		const thinkTag = selects.createDiv('mh-diar');
		setIcon(thinkTag.createSpan('mh-diar-icon'), 'brain');
		thinkTag.createSpan({ text: 'Thinking' });
		const thinkSel = thinkTag.createEl('select', { cls: 'mh-think-select' });
		const THINK_OPTIONS: [ReasoningLevel, string][] = [
			['off', 'Off'],
			['low', 'Low'],
			['medium', 'Medium'],
			['high', 'High'],
			['xhigh', 'Extra high'],
			['max', 'Max'],
		];
		for (const [val, label] of THINK_OPTIONS) thinkSel.createEl('option', { value: val, text: label });
		thinkSel.value = s.reasoningEffort;
		thinkSel.disabled = disabled;
		thinkSel.onchange = () => {
			s.reasoningEffort = thinkSel.value as ReasoningLevel;
		};
	}

	private renderEmpty(root: HTMLElement): void {
		const empty = root.createDiv('mh-empty');
		setIcon(empty.createDiv('mh-empty-icon'), 'sparkles');
		empty.createEl('p', {
			cls: 'mh-empty-text',
			text: 'Record a meeting or import an audio clip. Add any notes as context, and a summary is written for you.',
		});
	}

	/**
	 * Insert a tag/participant chip just before `before` (the text input). Adding a
	 * chip this way avoids a full re-render, so the input keeps focus and the user can
	 * keep typing the next entry instead of the cursor jumping away.
	 */
	private insertChip(wrap: HTMLElement, before: HTMLElement, text: string, onRemove: () => void): void {
		const chip = createSpan('mh-tag');
		wrap.insertBefore(chip, before);
		chip.createSpan({ text });
		const remove = chip.createSpan({ cls: 'mh-tag-x', text: '×' });
		remove.onclick = onRemove;
	}

	private renderMeta(root: HTMLElement): void {
		const s = this.s;
		const meta = root.createDiv('mh-meta');
		const busy = s.status === 'summarizing' || s.status === 'transcribing';
		const canGenerate = !!(s.summary || s.transcript);

		const titleField = meta.createDiv('mh-field');
		const titleHead = titleField.createDiv('mh-label-row');
		titleHead.createEl('label', { text: 'Title', cls: 'mh-label' });
		const titleRegen = titleHead.createEl('button', {
			cls: 'mh-icon-btn',
			attr: { 'aria-label': 'Regenerate title', title: 'Regenerate title' },
		});
		setIcon(titleRegen.createSpan(), 'refresh-cw');
		titleRegen.disabled = busy || !canGenerate;
		titleRegen.onclick = () => this.plugin.regenerateTitle();
		const titleInput = titleField.createEl('input', {
			cls: 'mh-input',
			attr: { type: 'text', placeholder: 'Untitled meeting' },
		});
		titleInput.value = s.title;
		titleInput.oninput = () => (s.title = titleInput.value);

		const partField = meta.createDiv('mh-field');
		partField.createEl('label', { text: 'Participants', cls: 'mh-label' });
		const partWrap = partField.createDiv('mh-tags');
		for (const person of s.participants) {
			const chip = partWrap.createSpan('mh-tag');
			chip.createSpan({ text: person });
			const remove = chip.createSpan({ cls: 'mh-tag-x', text: '×' });
			remove.onclick = () => {
				s.participants = s.participants.filter((p) => p !== person);
				this.render();
			};
		}
		const addPart = partWrap.createEl('input', {
			cls: 'mh-tag-input',
			attr: { type: 'text', placeholder: '+ name' },
		});
		addPart.onkeydown = (e: KeyboardEvent) => {
			if (e.key !== 'Enter') return;
			e.preventDefault();
			const name = addPart.value.trim();
			if (name && !s.participants.some((p) => p.toLowerCase() === name.toLowerCase())) {
				s.participants.push(name);
				this.insertChip(partWrap, addPart, name, () => {
					s.participants = s.participants.filter((p) => p !== name);
					this.render();
				});
			}
			addPart.value = '';
		};

		const tagsField = meta.createDiv('mh-field');
		const tagsHead = tagsField.createDiv('mh-label-row');
		tagsHead.createEl('label', { text: 'Tags', cls: 'mh-label' });
		const tagsRegen = tagsHead.createEl('button', {
			cls: 'mh-icon-btn',
			attr: { 'aria-label': 'Regenerate tags', title: 'Regenerate tags' },
		});
		setIcon(tagsRegen.createSpan(), 'refresh-cw');
		tagsRegen.disabled = busy || !canGenerate;
		tagsRegen.onclick = () => this.plugin.regenerateTags();
		const tagsWrap = tagsField.createDiv('mh-tags');
		for (const tag of s.tags) {
			const chip = tagsWrap.createSpan('mh-tag');
			chip.createSpan({ text: '#' + tag });
			const remove = chip.createSpan({ cls: 'mh-tag-x', text: '×' });
			remove.onclick = () => {
				s.tags = s.tags.filter((t) => t !== tag);
				this.render();
			};
		}
		const addTag = tagsWrap.createEl('input', {
			cls: 'mh-tag-input',
			attr: { type: 'text', placeholder: '+ tag' },
		});
		addTag.onkeydown = (e: KeyboardEvent) => {
			if (e.key !== 'Enter') return;
			e.preventDefault();
			const t = normalizeTag(addTag.value);
			if (t && !s.tags.some((x) => x.toLowerCase() === t.toLowerCase())) {
				s.tags.push(t);
				this.insertChip(tagsWrap, addTag, '#' + t, () => {
					s.tags = s.tags.filter((x) => x !== t);
					this.render();
				});
			}
			addTag.value = '';
		};
	}

	private renderContext(root: HTMLElement): void {
		const s = this.s;
		const section = root.createDiv('mh-context');
		const head = section.createDiv('mh-section-head');
		head.createSpan({ text: 'Context files', cls: 'mh-section-title' });
		const add = head.createEl('button', { cls: 'mh-mini-btn' });
		setIcon(add.createSpan(), 'plus');
		add.createSpan({ text: 'Add' });
		add.onclick = () => this.pickContextFile();

		if (s.contextFiles.length === 0) {
			section.createDiv({ cls: 'mh-hint', text: 'Add notes (agenda, prior meetings) to steer the summary.' });
		} else {
			const list = section.createDiv('mh-chip-list');
			for (const path of s.contextFiles) {
				const chip = list.createDiv('mh-chip');
				setIcon(chip.createSpan('mh-chip-icon'), 'file-text');
				chip.createSpan({ text: path.split('/').pop() ?? path, cls: 'mh-chip-name', attr: { title: path } });
				const x = chip.createSpan({ cls: 'mh-chip-x', text: '×' });
				x.onclick = () => {
					s.contextFiles = s.contextFiles.filter((p) => p !== path);
					this.render();
				};
			}
		}
	}

	private renderReview(root: HTMLElement): void {
		const s = this.s;
		const section = root.createDiv('mh-review');

		const tabs = section.createDiv('mh-tabs');
		const tabDef: { id: ReviewTab; label: string }[] = [
			{ id: 'summary', label: 'Summary' },
			{ id: 'transcript', label: 'Transcript' },
			{ id: 'memo', label: 'Memo' },
		];
		for (const t of tabDef) {
			const btn = tabs.createEl('button', {
				cls: ['mh-tab', s.activeTab === t.id ? 'is-active' : ''],
				text: t.label,
			});
			btn.onclick = () => {
				s.activeTab = t.id;
				this.render();
			};
		}

		const body = section.createDiv('mh-review-body');
		if (s.activeTab === 'summary') this.renderSummaryTab(body);
		else if (s.activeTab === 'transcript') this.renderTranscriptTab(body);
		else this.renderMemoTab(body);
	}

	private renderSummaryTab(body: HTMLElement): void {
		const s = this.s;
		const streaming = s.status === 'summarizing' && s.stream;

		const bar = body.createDiv('mh-tab-bar');
		const regen = bar.createEl('button', { cls: 'mh-mini-btn' });
		setIcon(regen.createSpan(), 'refresh-cw');
		regen.createSpan({ text: s.summary ? 'Regenerate' : 'Summarize' });
		regen.disabled = !s.transcript || s.status === 'summarizing' || s.status === 'transcribing';
		regen.onclick = () => this.plugin.regenerateSummary();

		// Preview/edit toggle isn't meaningful mid-stream.
		if (s.summary && !streaming) {
			const toggle = bar.createEl('button', { cls: 'mh-mini-btn' });
			setIcon(toggle.createSpan(), s.previewSummary ? 'pencil' : 'eye');
			toggle.createSpan({ text: s.previewSummary ? 'Edit' : 'Preview' });
			toggle.onclick = () => {
				s.previewSummary = !s.previewSummary;
				this.render();
			};
		}

		if (streaming) {
			const area = body.createEl('textarea', {
				cls: 'mh-textarea',
				attr: { placeholder: 'Summarizing…', readonly: 'true' },
			});
			area.value = s.summary;
			this.streamSummaryEl = area;
			this.bindStreamScroll(area);
		} else if (s.previewSummary && s.summary) {
			const preview = body.createDiv('mh-markdown');
			MarkdownRenderer.render(this.app, s.summary, preview, '', this as Component);
		} else {
			const area = body.createEl('textarea', {
				cls: 'mh-textarea',
				attr: { placeholder: 'The summary will appear here after transcription.' },
			});
			area.value = s.summary;
			area.oninput = () => (s.summary = area.value);
		}

		this.renderReasoning(body, streaming);
	}

	/** Collapsible "Model thinking" section — shown only when there's reasoning to show. */
	private renderReasoning(body: HTMLElement, streaming: boolean): void {
		const s = this.s;
		const show = !!s.reasoning || (streaming && s.reasoningEffort !== 'off');
		if (!show) return;
		const det = body.createEl('details', { cls: 'mh-reasoning' });
		det.open = this.reasoningOpen;
		det.ontoggle = () => {
			this.reasoningOpen = det.open;
		};
		const summary = det.createEl('summary', { cls: 'mh-reasoning-summary' });
		setIcon(summary.createSpan('mh-diar-icon'), 'brain');
		summary.createSpan({ text: 'Model thinking' });
		const content = det.createEl('pre', { cls: 'mh-reasoning-body' });
		content.setText(s.reasoning || (streaming ? 'Thinking…' : ''));
		this.streamReasoningEl = content;
		this.bindStreamScroll(content);
	}

	/** Update the streaming summary/reasoning in place, without a full re-render. */
	updateStreaming(): void {
		const s = this.s;
		if (this.streamSummaryEl) {
			this.writeStreaming(this.streamSummaryEl, s.summary);
		}
		if (s.reasoning) {
			if (!this.streamReasoningEl) {
				// Reasoning started arriving after the first paint — do one full render so the
				// disclosure appears, then subsequent deltas update it in place.
				this.render();
				return;
			}
			this.writeStreaming(this.streamReasoningEl, s.reasoning);
		}
	}

	// How far from the bottom (px) still counts as "following" the stream.
	private static readonly STREAM_STICK_PX = 48;

	/**
	 * Follow the stream only while the user is at the bottom. Whether we're "stuck" is decided
	 * from the ACTUAL scroll position at write time (not just an event flag), so a scroll-up
	 * during fast streaming detaches even if its scroll event hasn't been processed yet — no
	 * tug-of-war with the autoscroll. When detached, the prior position is restored (writing a
	 * textarea's `.value` can itself jump to the bottom).
	 */
	private writeStreaming(el: HTMLTextAreaElement | HTMLElement, text: string): void {
		const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
		let stuck = (el as any)._stick !== false;
		if (stuck && dist > ScuttlebuttView.STREAM_STICK_PX) {
			stuck = false; // user has scrolled up — stop following
			(el as any)._stick = false;
		}
		const prev = el.scrollTop;
		if (el instanceof HTMLTextAreaElement) el.value = text;
		else el.setText(text);
		el.scrollTop = stuck ? el.scrollHeight : prev;
	}

	/**
	 * Wire a streaming element's stick-to-bottom behaviour: an upward wheel detaches
	 * immediately (any amount); scrolling back to the bottom re-attaches. Starts attached.
	 */
	private bindStreamScroll(el: HTMLElement): void {
		(el as any)._stick = true;
		el.addEventListener('wheel', (e: WheelEvent) => {
			if (e.deltaY < 0) (el as any)._stick = false;
		}, { passive: true });
		el.addEventListener('scroll', () => {
			if (el.scrollHeight - el.scrollTop - el.clientHeight < 4) (el as any)._stick = true;
		});
	}

	private renderTranscriptTab(body: HTMLElement): void {
		const s = this.s;
		const bar = body.createDiv('mh-tab-bar');
		const retry = bar.createEl('button', { cls: 'mh-mini-btn' });
		setIcon(retry.createSpan(), 'refresh-cw');
		retry.createSpan({ text: 'Re-transcribe' });
		retry.disabled = !s.audioData || s.status === 'transcribing' || s.status === 'summarizing';
		retry.setAttr('title', s.audioData ? 'Transcribe the audio again' : 'No audio available to re-transcribe');
		retry.onclick = () => this.plugin.retranscribe();

		const area = body.createEl('textarea', {
			cls: 'mh-textarea',
			attr: { placeholder: 'Transcript will appear here.' },
		});
		area.value = s.transcript;
		area.oninput = () => (s.transcript = area.value);
	}

	private renderMemoTab(body: HTMLElement): void {
		const s = this.s;
		body.createDiv({ cls: 'mh-hint', text: 'Your own notes. Used as context for the summary.' });
		const area = body.createEl('textarea', {
			cls: 'mh-textarea',
			attr: { placeholder: 'Jot down agenda items or notes…' },
		});
		area.value = s.memo;
		area.oninput = () => (s.memo = area.value);
	}

	private renderActions(root: HTMLElement): void {
		const s = this.s;
		const actions = root.createDiv('mh-actions');

		const save = actions.createEl('button', { cls: 'mh-primary-btn' });
		setIcon(save.createSpan(), 'save');
		save.createSpan({ text: s.savedNotePath ? 'Saved ✓  Save again' : 'Save note' });
		save.disabled = (!s.summary && !s.transcript) || this.plugin.isBusy();
		save.onclick = () => {
			const prev = s.savedNotePath;
			if (prev && this.app.vault.getAbstractFileByPath(prev)) {
				new SaveChoiceModal(
					this.app,
					prev,
					() => this.plugin.saveNote('replace'),
					() => this.plugin.saveNote('new')
				).open();
			} else {
				this.plugin.saveNote('new');
			}
		};

		const reset = actions.createEl('button', { cls: 'mh-ghost-btn mh-reset' });
		setIcon(reset.createSpan(), 'rotate-ccw');
		reset.createSpan({ text: 'New' });
		reset.disabled = s.status === 'recording';
		reset.onclick = () => {
			if (this.plugin.isBusy()) {
				new ConfirmModal(
					this.app,
					'A transcription or summary is in progress. Cancel it and start a new session?',
					'Cancel run & start new',
					() => {
						this.plugin.cancelActive();
						this.plugin.resetSession();
					}
				).open();
			} else {
				this.plugin.resetSession();
			}
		};

		if (s.savedNotePath) {
			const open = actions.createEl('button', { cls: 'mh-ghost-btn' });
			setIcon(open.createSpan(), 'external-link');
			open.createSpan({ text: 'Open' });
			open.onclick = () => this.app.workspace.openLinkText(s.savedNotePath!, '', false);
		}
	}

	private renderProgress(root: HTMLElement): void {
		const s = this.s;
		if (!s.progressLabel && !s.error) return;
		const wrap = root.createDiv('mh-progress');
		if (s.error) {
			const err = wrap.createDiv('mh-error');
			setIcon(err.createSpan('mh-error-icon'), 'alert-triangle');
			err.createSpan({ text: s.error });
		} else {
			const track = wrap.createDiv('mh-bar-track');
			const fill = track.createDiv('mh-bar-fill');
			fill.style.width = Math.max(4, Math.min(100, s.progressPct)) + '%';
			if (s.progressPct < 100) fill.addClass('is-animated');
			const row = wrap.createDiv('mh-progress-row');
			row.createDiv({ cls: 'mh-progress-label', text: s.progressLabel });
			if (s.status === 'transcribing' || s.status === 'summarizing') {
				const cancel = row.createEl('button', { cls: 'mh-cancel-btn', text: 'Cancel' });
				cancel.onclick = () => this.plugin.cancelActive();
			}
		}
	}

	// ---- input handlers --------------------------------------------------

	private pickAudioFromVault(): void {
		const files = this.app.vault
			.getFiles()
			.filter((f) => AUDIO_EXTENSIONS.includes(f.extension.toLowerCase()));
		if (files.length === 0) {
			new Notice('No audio files found in this vault.');
			return;
		}
		new FileSuggestModal(this.app, files, (file) => this.plugin.importFromVault(file), 'Pick an audio clip…').open();
	}

	private uploadAudioFromDisk(): void {
		const input = createEl('input', { attr: { type: 'file', accept: 'audio/*' } });
		input.onchange = async () => {
			const file = input.files?.[0];
			if (file) await this.plugin.importFromDisk(file);
		};
		input.click();
	}

	private pickContextFile(): void {
		const chosen = new Set(this.s.contextFiles);
		const files = this.app.vault.getMarkdownFiles().filter((f) => !chosen.has(f.path));
		if (files.length === 0) {
			new Notice('No more markdown files to add.');
			return;
		}
		new FileSuggestModal(
			this.app,
			files,
			(file) => {
				this.s.contextFiles.push(file.path);
				this.render();
			},
			'Add a context note…'
		).open();
	}
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class ScuttlebuttPlugin extends Plugin {
	declare settings: ScuttlebuttSettings;
	session: MeetingSession = newSession();
	recorder = new MeetingRecorder();
	ai!: AIService;
	private statusBarEl: HTMLElement | null = null;
	private statusBarTimer: number | null = null;
	// In-flight transcription/summary request, so the user can cancel it. Each run owns
	// its own AbortController; catch handlers classify a user abort via controller.signal.aborted.
	private activeController: AbortController | null = null;
	private startingRecording = false;

	/** True while a transcription, summary, or save is running. */
	isBusy(): boolean {
		const st = this.session.status;
		return st === 'transcribing' || st === 'summarizing' || st === 'saving';
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		// The initial session was field-initialised before settings loaded — seed its run
		// options from the settings now so the first recording reflects the configured defaults.
		this.session.diarize = this.settings.sttDiarize;
		this.session.reasoningEffort = this.settings.reasoningEffort;
		this.session.stream = this.settings.streamSummary;

		this.registerView(VIEW_TYPE_SCUTTLEBUTT, (leaf) => new ScuttlebuttView(leaf, this));
		this.addRibbonIcon('mic', 'Scuttlebutt', () => this.activateView());

		this.addCommand({ id: 'open-sidebar', name: 'Open sidebar', callback: () => this.activateView() });
		this.addCommand({
			id: 'toggle-recording',
			name: 'Start / stop recording',
			callback: () => this.toggleRecording(),
		});
		this.addCommand({
			id: 'toggle-pause',
			name: 'Pause / resume recording',
			checkCallback: (checking) => {
				const can = this.recorder.isActive();
				if (can && !checking) this.togglePause();
				return can;
			},
		});
		this.addCommand({
			id: 'process-recording',
			name: 'Transcribe & summarize current recording',
			checkCallback: (checking) => {
				const can = !!this.session.audioData && !this.isBusy();
				if (can && !checking) this.runPipeline();
				return can;
			},
		});
		this.addCommand({
			id: 'save-note',
			name: 'Save meeting note',
			checkCallback: (checking) => {
				const can = !!(this.session.summary || this.session.transcript) && !this.isBusy();
				if (can && !checking) this.saveNote();
				return can;
			},
		});

		this.addSettingTab(new ScuttlebuttSettingTab(this.app, this));

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('mh-statusbar');
		this.statusBarEl.style.display = 'none';
	}

	onunload(): void {
		this.recorder.abort();
		this.stopStatusBarTimer();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.ai = new AIService(this.settings);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.ai = new AIService(this.settings);
		this.refreshViews();
	}

	async activateView(): Promise<void> {
		try {
			const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCUTTLEBUTT);
			if (existing.length > 0) {
				this.app.workspace.revealLeaf(existing[0]);
				return;
			}
			const leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) {
				new Notice('Could not open the Scuttlebutt sidebar.');
				return;
			}
			await leaf.setViewState({ type: VIEW_TYPE_SCUTTLEBUTT, active: true });
			this.app.workspace.revealLeaf(leaf);
		} catch (err) {
			console.error('Scuttlebutt: failed to open sidebar', err);
			new Notice('Failed to open sidebar: ' + (err as Error).message);
		}
	}

	getViews(): ScuttlebuttView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_SCUTTLEBUTT)
			.map((leaf) => leaf.view)
			.filter((v): v is ScuttlebuttView => v instanceof ScuttlebuttView);
	}

	refreshViews(): void {
		for (const view of this.getViews()) view.render();
	}

	/**
	 * A new empty session that inherits the current session's run options (speakers /
	 * thinking / streaming). Used when a recording or import begins, so choices made after
	 * "New" persist into the run instead of being reset to the global defaults.
	 */
	private freshSession(): MeetingSession {
		const s = this.session;
		return newSession(s.diarize, s.reasoningEffort, s.stream);
	}

	/** Push streaming summary/reasoning into open views in place (no full re-render). */
	private updateStreamingViews(): void {
		for (const view of this.getViews()) view.updateStreaming();
	}

	private setStatus(status: SessionStatus): void {
		this.session.status = status;
	}

	private setProgress(label: string, pct: number): void {
		this.session.progressLabel = label;
		this.session.progressPct = pct;
	}

	// ---- recording -------------------------------------------------------

	async toggleRecording(): Promise<void> {
		if (this.recorder.isRecording()) {
			await this.stopRecording();
		} else {
			await this.startRecording();
		}
	}

	async startRecording(): Promise<void> {
		// Synchronous guard: a second call (double-click, ribbon + command) before the first
		// resolves would start a concurrent recorder and orphan the first mic stream.
		if (this.recorder.isActive() || this.startingRecording) return;
		this.startingRecording = true;
		try {
		if (this.session.status !== 'idle' && this.session.status !== 'error') {
			// Fresh recording starts a fresh session unless there is unsaved review content.
			if (this.session.summary || this.session.transcript) {
				new Notice('Finish or clear the current meeting first ("New").');
				await this.activateView();
				return;
			}
		}
		let result: { systemAudio: boolean };
		try {
			result = await this.recorder.start({
				inputDeviceId: this.settings.inputDeviceId,
				systemAudioDeviceId: this.settings.systemAudioDeviceId,
				captureSystemAudio: this.settings.captureSystemAudio,
			});
		} catch (err: any) {
			new Notice('Microphone access failed: ' + (err?.message ?? err));
			return;
		}
		if ((this.settings.systemAudioDeviceId || this.settings.captureSystemAudio) && !result.systemAudio) {
			new Notice(
				'System audio could not be captured — recording microphone only. ' +
					'On macOS, install a loopback device (e.g. BlackHole) and pick it as the ' +
					'System audio device in Settings → Capture.',
				8000
			);
		}
		this.session = this.freshSession();
		this.session.activeMs = 0;
		this.session.segmentStartedAt = Date.now();
		this.session.paused = false;
		this.setStatus('recording');
		this.startStatusBarTimer();
		await this.activateView();
		this.refreshViews();
		} finally {
			this.startingRecording = false;
		}
	}

	async stopRecording(): Promise<void> {
		if (!this.recorder.isActive()) return;
		const now = Date.now();
		if (this.session.segmentStartedAt !== null) {
			this.session.activeMs += now - this.session.segmentStartedAt;
			this.session.segmentStartedAt = null;
		}
		this.session.paused = false;
		this.session.elapsedMs = this.session.activeMs;
		const blob = await this.recorder.stop();
		this.stopStatusBarTimer();
		if (blob.size === 0) {
			new Notice('Recording was empty.');
			this.setStatus('idle');
			this.refreshViews();
			return;
		}
		this.session.audioData = await blob.arrayBuffer();
		this.session.audioMime = this.recorder.getMimeType();
		this.session.audioName = `recording ${todayStamp(new Date())} ${formatDuration(this.session.elapsedMs)}.webm`;
		this.session.audioSourcePath = null;
		this.setStatus('recorded');
		this.refreshViews();
		new Notice('Recording saved. Transcribing…');
		this.runPipeline();
	}

	togglePause(): void {
		if (!this.recorder.isActive()) return;
		const now = Date.now();
		if (this.session.paused) {
			this.recorder.resume();
			this.session.segmentStartedAt = now;
			this.session.paused = false;
		} else {
			this.recorder.pause();
			if (this.session.segmentStartedAt !== null) {
				this.session.activeMs += now - this.session.segmentStartedAt;
				this.session.segmentStartedAt = null;
			}
			this.session.paused = true;
		}
		this.refreshViews();
	}

	// ---- import ----------------------------------------------------------

	async importFromVault(file: TFile): Promise<void> {
		try {
			const data = await this.app.vault.readBinary(file);
			this.session = this.freshSession();
			this.session.audioData = data;
			this.session.audioMime = this.mimeForExtension(file.extension);
			this.session.audioName = file.name;
			this.session.audioSourcePath = file.path;
			this.setStatus('recorded');
			this.refreshViews();
			this.runPipeline();
		} catch (err: any) {
			new Notice('Could not read audio file: ' + (err?.message ?? err));
		}
	}

	async importFromDisk(file: File): Promise<void> {
		try {
			const data = await file.arrayBuffer();
			this.session = this.freshSession();
			this.session.audioData = data;
			this.session.audioMime = file.type || this.mimeForExtension(file.name.split('.').pop() ?? '');
			this.session.audioName = file.name;
			this.session.audioSourcePath = null;
			this.setStatus('recorded');
			await this.activateView();
			this.refreshViews();
			this.runPipeline();
		} catch (err: any) {
			new Notice('Could not read audio file: ' + (err?.message ?? err));
		}
	}

	private mimeForExtension(ext: string): string {
		const map: Record<string, string> = {
			webm: 'audio/webm',
			mp3: 'audio/mpeg',
			mpga: 'audio/mpeg',
			wav: 'audio/wav',
			m4a: 'audio/mp4',
			mp4: 'audio/mp4',
			ogg: 'audio/ogg',
			oga: 'audio/ogg',
			flac: 'audio/flac',
			aac: 'audio/aac',
		};
		return map[ext.toLowerCase()] ?? 'application/octet-stream';
	}

	// ---- pipeline --------------------------------------------------------

	async runPipeline(): Promise<void> {
		if (this.isBusy()) {
			new Notice('A transcription or summary is already running.');
			return;
		}
		const ok = await this.transcribeStep();
		if (!ok) return;

		// Summarize (+ title + tags), if enabled and configured.
		if (this.settings.autoSummarize && this.settings.llmEndpoint && this.settings.llmModel) {
			await this.summarizeInternal();
		} else {
			const s = this.session;
			this.setStatus('recorded');
			this.setProgress('Transcript ready. Review, then summarize when ready.', 100);
			s.activeTab = 'transcript';
			this.refreshViews();
			window.setTimeout(() => this.clearProgressIfIdle(), 4000);
		}
	}

	/** Re-run transcription on the current audio, leaving any existing summary in place. */
	async retranscribe(): Promise<void> {
		if (!this.session.audioData) {
			new Notice('No audio to transcribe.');
			return;
		}
		if (this.isBusy()) {
			new Notice('A transcription or summary is already running.');
			return;
		}
		const ok = await this.transcribeStep();
		if (!ok) return;
		this.setStatus(this.session.summary ? 'ready' : 'recorded');
		this.setProgress('Transcript updated.', 100);
		this.session.activeTab = 'transcript';
		this.refreshViews();
		window.setTimeout(() => this.clearProgressIfIdle(), 4000);
	}

	/** Transcribe the current audio into the session. Returns false (and sets error state) on failure. */
	private async transcribeStep(): Promise<boolean> {
		const s = this.session;
		if (!s.audioData) {
			new Notice('No audio to transcribe.');
			return false;
		}
		s.error = null;
		this.setStatus('transcribing');
		this.setProgress('Transcribing audio…', 30);
		this.refreshViews();
		const name = s.audioName || 'recording.webm';
		const wantSpeakers = s.diarize;
		const controller = new AbortController();
		this.activeController = controller;
		let result: { text: string; hasSpeakers: boolean };
		let fellBack = false;
		try {
			try {
				result = await this.ai.transcribe(s.audioData, name, s.audioMime, wantSpeakers, controller.signal);
			} catch (diarErr) {
				// A cancel or a non-diarized failure is terminal; only a diarized attempt
				// is worth retrying flat.
				if (controller.signal.aborted || !wantSpeakers) throw diarErr;
				fellBack = true;
				new Notice('Speaker identification failed — transcribing without speaker labels.');
				this.setProgress('Retrying without speaker identification…', 30);
				this.refreshViews();
				result = await this.ai.transcribe(s.audioData, name, s.audioMime, false, controller.signal);
			}
		} catch (err: any) {
			if (controller.signal.aborted) {
				this.finishCancelled();
				return false;
			}
			s.error = err?.message ?? String(err);
			this.setStatus('error');
			this.setProgress('', 0);
			this.refreshViews();
			new Notice('Transcription failed: ' + s.error);
			return false;
		} finally {
			if (this.activeController === controller) this.activeController = null;
		}
		s.transcript = result.text;
		// Diarization was requested and the request *succeeded*, but the endpoint gave
		// back no speaker labels — it silently ignored the request. Say so, so a flat
		// transcript doesn't look like the feature is broken. (Skip if we already fell
		// back above, which explained the flat result.)
		if (wantSpeakers && !fellBack && !result.hasSpeakers) {
			new Notice('This endpoint returned no speaker labels — saved as a flat transcript. It may not support speaker identification.');
		}
		if (!s.transcript.trim()) {
			s.error = 'Transcription returned no text. The clip may be silent or in an unsupported format.';
			this.setStatus('error');
			this.setProgress('', 0);
			this.refreshViews();
			return false;
		}
		return true;
	}

	async regenerateSummary(): Promise<void> {
		if (!this.session.transcript.trim()) {
			new Notice('Nothing to summarize yet.');
			return;
		}
		if (this.isBusy()) {
			new Notice('A transcription or summary is already running.');
			return;
		}
		await this.summarizeInternal();
	}

	/** Regenerate just the title (or just the tags) from the current summary/transcript. */
	async regenerateTitle(): Promise<void> {
		await this.regeneratePiece('title');
	}

	async regenerateTags(): Promise<void> {
		await this.regeneratePiece('tags');
	}

	private async regeneratePiece(piece: 'title' | 'tags'): Promise<void> {
		const s = this.session;
		const basis = s.summary || s.transcript;
		if (!basis.trim()) {
			new Notice('Summarize or transcribe first.');
			return;
		}
		if (s.status === 'summarizing' || s.status === 'transcribing') return;
		const controller = new AbortController();
		this.activeController = controller;
		this.setStatus('summarizing');
		this.setProgress(piece === 'title' ? 'Naming…' : 'Tagging…', 80);
		this.refreshViews();
		try {
			if (piece === 'title') {
				s.title = await this.ai.generateTitle(basis, controller.signal, s.reasoningEffort);
			} else {
				s.tags = await this.ai.generateTags(s.title, basis, this.getVaultTags(), controller.signal, s.reasoningEffort);
			}
			this.setStatus('ready');
			this.setProgress(piece === 'title' ? 'Title updated.' : 'Tags updated.', 100);
			this.refreshViews();
			window.setTimeout(() => this.clearProgressIfIdle(), 3000);
		} catch (err: any) {
			if (controller.signal.aborted) {
				this.finishCancelled();
				return;
			}
			this.setStatus(s.summary ? 'ready' : 'recorded');
			this.setProgress('', 0);
			this.refreshViews();
			new Notice(`${piece === 'title' ? 'Title' : 'Tag'} generation failed: ${err?.message ?? err}`);
		} finally {
			if (this.activeController === controller) this.activeController = null;
		}
	}

	private async summarizeInternal(): Promise<void> {
		const s = this.session;
		s.error = null;
		s.summary = '';
		s.reasoning = '';
		this.setStatus('summarizing');
		this.setProgress('Summarizing…', 60);
		s.activeTab = 'summary';
		this.refreshViews();

		const contextDocs = await this.readContextDocs();

		const controller = new AbortController();
		this.activeController = controller;
		try {
			try {
				const result = await this.ai.summarize(
					{
						transcript: s.transcript,
						memo: s.memo,
						participants: s.participants.join(', '),
						contextDocs,
					},
					{
						signal: controller.signal,
						reasoning: s.reasoningEffort,
						onDelta: s.stream
							? (answer, reasoning) => {
									s.summary = answer;
									s.reasoning = reasoning;
									this.updateStreamingViews();
							  }
							: undefined,
					}
				);
				s.summary = result.summary;
				s.reasoning = result.reasoning;
			} catch (err: any) {
				if (controller.signal.aborted) {
					this.finishCancelled();
					return;
				}
				s.error = err?.message ?? String(err);
				this.setStatus('error');
				this.setProgress('', 0);
				this.refreshViews();
				new Notice('Summarization failed: ' + s.error);
				return;
			}

			// Title + tags are best-effort; failures here don't block the summary
			// (but a cancel still stops the whole run).
			this.setProgress('Naming & tagging…', 85);
			this.refreshViews();
			const basis = s.summary || s.transcript;

			if (this.settings.generateTitle && !s.title.trim()) {
				try {
					s.title = await this.ai.generateTitle(basis, controller.signal, s.reasoningEffort);
				} catch (err) {
					if (controller.signal.aborted) {
						this.finishCancelled();
						return;
					}
					console.warn('Scuttlebutt: title generation failed', err);
				}
			}
			if (this.settings.generateTags && s.tags.length === 0) {
				try {
					s.tags = await this.ai.generateTags(s.title, basis, this.getVaultTags(), controller.signal, s.reasoningEffort);
				} catch (err) {
					if (controller.signal.aborted) {
						this.finishCancelled();
						return;
					}
					console.warn('Scuttlebutt: tag generation failed', err);
				}
			}

			// Note shape: a single title H1, then the overview, then ## / smaller
			// sections. Uses the generated title (falls back to "Summary").
			s.summary = structureSummary(s.summary, s.title.trim() || 'Summary');

			this.setStatus('ready');
			this.setProgress('Summary ready. Review and save.', 100);
			this.refreshViews();
			window.setTimeout(() => this.clearProgressIfIdle(), 4000);
		} finally {
			if (this.activeController === controller) this.activeController = null;
		}
	}

	private clearProgressIfIdle(): void {
		if (this.session.status === 'ready' || this.session.status === 'recorded') {
			this.setProgress('', 0);
			this.refreshViews();
		}
	}

	/** Abort the in-flight transcription/summary request, if any. */
	cancelActive(): void {
		if (!this.activeController) return;
		this.activeController.abort();
		this.setProgress('Cancelling…', this.session.progressPct);
		this.refreshViews();
	}

	/** Reset the UI to a usable state after the user cancels, keeping any existing work. */
	private finishCancelled(): void {
		const s = this.session;
		s.error = null;
		this.setStatus(s.summary ? 'ready' : s.audioData ? 'recorded' : 'idle');
		this.setProgress('', 0);
		this.refreshViews();
		new Notice('Cancelled.');
	}

	private async readContextDocs(): Promise<{ path: string; content: string }[]> {
		const docs: { path: string; content: string }[] = [];
		for (const path of this.session.contextFiles) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				try {
					docs.push({ path, content: await this.app.vault.cachedRead(file) });
				} catch {
					new Notice(`Could not read context file: ${path}`);
				}
			} else {
				new Notice(`Context file missing, skipped: ${path}`);
			}
		}
		return docs;
	}

	private getVaultTags(): string[] {
		try {
			// getTags() is an undocumented (but stable) MetadataCache method not in the typings.
			const cache = this.app.metadataCache as unknown as { getTags?: () => Record<string, number> };
			const tags = cache.getTags?.();
			if (!tags) return [];
			return Object.keys(tags)
				.map((t) => t.replace(/^#/, ''))
				.slice(0, 100);
		} catch {
			return [];
		}
	}

	// ---- saving ----------------------------------------------------------

	async saveNote(mode: 'new' | 'replace' = 'new'): Promise<void> {
		const s = this.session;
		if (!s.summary && !s.transcript) {
			new Notice('Nothing to save yet.');
			return;
		}
		if (this.isBusy() && s.status !== 'saving') {
			new Notice('Wait for the current step to finish before saving.');
			return;
		}
		this.setStatus('saving');
		this.setProgress('Saving note…', 90);
		this.refreshViews();

		try {
			let audioLink: string | null = s.audioSourcePath;
			if (this.settings.saveAudio && s.audioData && !s.audioSourcePath) {
				audioLink = await this.saveAudioFile();
			}

			const replacePath = mode === 'replace' ? s.savedNotePath : null;
			const notePath = await this.writeNote(audioLink, replacePath);
			s.savedNotePath = notePath;
			this.setStatus('ready');
			this.setProgress('Saved ✓', 100);
			this.refreshViews();
			new Notice('Meeting note saved: ' + notePath);

			if (this.settings.autoOpenNote) {
				this.app.workspace.openLinkText(notePath, '', true);
			}
			window.setTimeout(() => this.clearProgressIfIdle(), 4000);
		} catch (err: any) {
			s.error = 'Could not save note: ' + (err?.message ?? err);
			this.setStatus('error');
			this.setProgress('', 0);
			this.refreshViews();
			new Notice(s.error);
		}
	}

	private async saveAudioFile(): Promise<string> {
		const s = this.session;
		await this.ensureFolder(this.settings.audioFolder);
		const ext = (s.audioName.split('.').pop() || 'webm').toLowerCase();
		const base = sanitizeFileName(`${todayStamp(new Date())} ${s.title || 'recording'}`);
		const path = await this.uniquePath(this.settings.audioFolder, base, ext);
		await this.app.vault.createBinary(path, s.audioData!);
		return path;
	}

	private async writeNote(audioLink: string | null, replacePath?: string | null): Promise<string> {
		const s = this.session;
		await this.ensureFolder(this.settings.notesFolder);

		const now = new Date();
		const title = s.title.trim() || 'Meeting';
		const base = sanitizeFileName(`${todayStamp(now)} — ${title}`);
		const existing = replacePath ? this.app.vault.getAbstractFileByPath(replacePath) : null;
		const path =
			existing instanceof TFile ? existing.path : await this.uniquePath(this.settings.notesFolder, base, 'md');

		const fm: string[] = ['---'];
		fm.push(`date created: ${yamlString(mmt(now).format(this.settings.dateFormat || DEFAULT_DATE_FORMAT))}`);
		if (s.tags.length > 0) fm.push(`tags: [${s.tags.map(yamlString).join(', ')}]`);
		if (s.participants.length > 0) {
			fm.push(`participants: [${s.participants.map(yamlString).join(', ')}]`);
		}
		fm.push('---', '');

		const parts: string[] = [fm.join('\n')];

		if (audioLink) parts.push(`![[${audioLink}]]`, '');

		parts.push(s.summary.trim() || '*No summary generated.*');

		if (this.settings.includeMemo && s.memo.trim()) {
			parts.push('', calloutBlock('quote', 'Memo', s.memo.trim(), true));
		}
		if (this.settings.includeTranscript && s.transcript.trim()) {
			parts.push('', calloutBlock('note', 'Transcript', s.transcript.trim(), true));
		}

		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, parts.join('\n') + '\n');
			return existing.path;
		}
		const file = await this.app.vault.create(path, parts.join('\n') + '\n');
		return file.path;
	}

	// ---- reset -----------------------------------------------------------

	resetSession(): void {
		if (this.recorder.isRecording()) this.recorder.abort();
		this.stopStatusBarTimer();
		this.session = newSession(this.settings.sttDiarize, this.settings.reasoningEffort, this.settings.streamSummary);
		this.refreshViews();
	}

	// ---- filesystem helpers ---------------------------------------------

	private async ensureFolder(folder: string): Promise<void> {
		const norm = normalizePath(folder);
		if (!norm || norm === '/' || norm === '.') return;
		const segments = norm.split('/');
		let current = '';
		for (const seg of segments) {
			current = current ? `${current}/${seg}` : seg;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				try {
					await this.app.vault.createFolder(current);
				} catch (err) {
					// Ignore "already exists" races; rethrow anything else.
					if (!this.app.vault.getAbstractFileByPath(current)) throw err;
				}
			}
		}
	}

	private async uniquePath(folder: string, base: string, ext: string): Promise<string> {
		const dir = normalizePath(folder);
		let candidate = normalizePath(`${dir}/${base}.${ext}`);
		let i = 2;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = normalizePath(`${dir}/${base} (${i}).${ext}`);
			i++;
		}
		return candidate;
	}

	// ---- status bar ------------------------------------------------------

	private startStatusBarTimer(): void {
		this.updateStatusBar();
		if (this.statusBarTimer !== null) return;
		this.statusBarTimer = window.setInterval(() => this.updateStatusBar(), 1000);
		this.registerInterval(this.statusBarTimer);
	}

	private stopStatusBarTimer(): void {
		if (this.statusBarTimer !== null) {
			window.clearInterval(this.statusBarTimer);
			this.statusBarTimer = null;
		}
		if (this.statusBarEl) this.statusBarEl.style.display = 'none';
	}

	private updateStatusBar(): void {
		if (!this.statusBarEl) return;
		if (this.session.status === 'recording') {
			this.statusBarEl.style.display = '';
			this.statusBarEl.empty();
			this.statusBarEl.createSpan({ cls: 'mh-sb-dot' });
			const t = formatDuration(recordedMs(this.session.activeMs, this.session.segmentStartedAt, Date.now()));
			this.statusBarEl.createSpan({ text: ' ' + t + (this.session.paused ? ' (paused)' : '') });
			this.statusBarEl.onclick = () => this.activateView();
		} else {
			this.statusBarEl.style.display = 'none';
		}
	}
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class ScuttlebuttSettingTab extends PluginSettingTab {
	private audioInputs: AudioInput[] = [];
	private deviceDropdown: DropdownComponent | null = null;
	private systemDeviceDropdown: DropdownComponent | null = null;

	constructor(app: App, private plugin: ScuttlebuttPlugin) {
		super(app, plugin);
	}

	/** Request mic permission (to unlock device labels), then list audio inputs and re-render. */
	private async detectDevices(): Promise<void> {
		try {
			const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
			probe.getTracks().forEach((t) => t.stop());
		} catch {
			new Notice('Microphone permission is needed to list input devices.');
		}
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			this.audioInputs = devices
				.filter((d) => d.kind === 'audioinput')
				.map((d) => ({ deviceId: d.deviceId, label: d.label }));
			// Cache the list so the pickers show the saved selection after a reload,
			// without the user having to re-detect every time.
			this.plugin.settings.audioDevices = this.audioInputs;
			await this.plugin.saveSettings();
			new Notice(`Found ${this.audioInputs.length} input device${this.audioInputs.length === 1 ? '' : 's'}.`);
		} catch {
			this.audioInputs = [];
		}
		// Repopulate the device dropdowns in place rather than this.display(), which
		// would rebuild the settings tab and scroll it back to the top.
		if (this.deviceDropdown) this.populateDeviceDropdown(this.deviceDropdown, 'inputDeviceId', 'System default');
		if (this.systemDeviceDropdown) {
			this.populateDeviceDropdown(this.systemDeviceDropdown, 'systemAudioDeviceId', 'Off');
		}
	}

	/** Fill a device dropdown from the detected inputs. Used on first render and after
	 *  re-detecting, so a refresh doesn't rebuild the whole settings tab. */
	private populateDeviceDropdown(
		d: DropdownComponent,
		key: 'inputDeviceId' | 'systemAudioDeviceId',
		firstLabel: string
	): void {
		d.selectEl.empty();
		d.addOption('', firstLabel);
		for (const dev of this.audioInputs) {
			d.addOption(dev.deviceId, dev.label || `Input (${dev.deviceId.slice(0, 6)}…)`);
		}
		const saved = this.plugin.settings[key];
		d.setValue(this.audioInputs.some((x) => x.deviceId === saved) ? saved : '');
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('mh-settings');

		// Seed the device pickers from the cached list so the saved input/system devices
		// show immediately on open, even before (or without) a fresh detect.
		if (this.audioInputs.length === 0) this.audioInputs = this.plugin.settings.audioDevices ?? [];

		this.endpointSection(containerEl, {
			heading: 'Transcription',
			desc: 'Your Whisper / vLLM speech-to-text server (OpenAI-compatible).',
			endpointKey: 'sttEndpoint',
			apiKeyKey: 'sttApiKey',
			modelKey: 'sttModel',
			modelsKey: 'sttModels',
			timeoutKey: 'sttTimeout',
		});

		new Setting(containerEl)
			.setName('Language')
			.setDesc('Spoken language hint for transcription (e.g. en, zh, ja). Use "auto" to let the model detect.')
			.addText((t) =>
				t.setValue(this.plugin.settings.sttLanguage).onChange(async (v) => {
					this.plugin.settings.sttLanguage = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Identify speakers')
			.setDesc(
				'Default for new recordings: ask the server to label who said what (diarization). ' +
					'You can flip it per recording in the sidebar. Requires a diarizing endpoint such as ' +
					'the WhisperX server; plain Whisper/vLLM will ignore it.'
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.sttDiarize).onChange(async (v) => {
					this.plugin.settings.sttDiarize = v;
					await this.plugin.saveSettings();
				})
			);

		this.endpointSection(containerEl, {
			heading: 'Summary',
			desc: 'Your LLM / vLLM chat server (OpenAI-compatible). Used for summaries, titles, and tags.',
			endpointKey: 'llmEndpoint',
			apiKeyKey: 'llmApiKey',
			modelKey: 'llmModel',
			modelsKey: 'llmModels',
			timeoutKey: 'llmTimeout',
		});

		new Setting(containerEl)
			.setName('Reasoning effort')
			.setDesc(
				'How hard a thinking model (e.g. Qwen3) reasons before answering. "Off" disables thinking — ' +
					'recommended for summaries, and required for models that would otherwise burn the whole ' +
					'token budget on <think>. Higher levels enable thinking and reserve more room for it; ' +
					'servers that support reasoning_effort (OpenAI-style) use the exact level.'
			)
			.addDropdown((d) => {
				d.addOption('off', 'Off (no thinking)');
				d.addOption('low', 'Low');
				d.addOption('medium', 'Medium');
				d.addOption('high', 'High');
				d.addOption('xhigh', 'Extra high');
				d.addOption('max', 'Max');
				d.setValue(this.plugin.settings.reasoningEffort ?? 'off');
				d.onChange(async (v) => {
					this.plugin.settings.reasoningEffort = v as ReasoningLevel;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Stream summary')
			.setDesc(
				'Show the summary as it generates, token by token, instead of waiting for the whole ' +
					'thing. Falls back to a single request on servers that can\'t stream. Model thinking, ' +
					'when enabled, streams into a separate collapsible section.'
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.streamSummary).onChange(async (v) => {
					this.plugin.settings.streamSummary = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName('Capture').setHeading();

		new Setting(containerEl)
			.setName('Input device')
			.setDesc(
				'Which microphone/input to record. To capture system audio on macOS, install a loopback ' +
					'device (e.g. BlackHole) and record from an aggregate device that includes it, then select it here.'
			)
			.addDropdown((d) => {
				this.deviceDropdown = d;
				this.populateDeviceDropdown(d, 'inputDeviceId', 'System default');
				d.onChange(async (v) => {
					this.plugin.settings.inputDeviceId = v;
					await this.plugin.saveSettings();
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon('refresh-cw')
					.setTooltip('Detect input devices')
					.onClick(() => this.detectDevices())
			);

		new Setting(containerEl)
			.setName('System audio device')
			.setDesc(
				'Optional second input, recorded alongside the mic and mixed into one track. Pick a ' +
					'loopback device that carries system/meeting audio (e.g. BlackHole on macOS). ' +
					'Leave "Off" to record the microphone only.'
			)
			.addDropdown((d) => {
				this.systemDeviceDropdown = d;
				this.populateDeviceDropdown(d, 'systemAudioDeviceId', 'Off');
				d.onChange(async (v) => {
					this.plugin.settings.systemAudioDeviceId = v;
					await this.plugin.saveSettings();
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon('refresh-cw')
					.setTooltip('Detect input devices')
					.onClick(() => this.detectDevices())
			);

		new Setting(containerEl)
			.setName('Capture system audio')
			.setDesc(
				'Alternative to the device above: mix in system audio via a screen-share prompt. ' +
					'Works on some platforms but not reliably on macOS — if no system audio is captured ' +
					'you will be told, and recording continues with the microphone. On macOS, prefer the ' +
					'"System audio device" option above.'
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.captureSystemAudio).onChange(async (v) => {
					this.plugin.settings.captureSystemAudio = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName('Behavior').setHeading();

		new Setting(containerEl)
			.setName('Auto-summarize after transcription')
			.setDesc('Generate the summary automatically once a transcript is ready.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoSummarize).onChange(async (v) => {
					this.plugin.settings.autoSummarize = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Suggest a title')
			.setDesc('Let the model name the meeting (anarlog-style concise topic).')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.generateTitle).onChange(async (v) => {
					this.plugin.settings.generateTitle = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Suggest tags')
			.setDesc('Let the model propose 3–5 tags, reusing your existing vault tags where relevant.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.generateTags).onChange(async (v) => {
					this.plugin.settings.generateTags = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Summary language')
			.setDesc('The language the summary and title are written in.')
			.addText((t) =>
				t.setValue(this.plugin.settings.language).onChange(async (v) => {
					this.plugin.settings.language = v.trim() || 'English';
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName('Output').setHeading();

		new Setting(containerEl)
			.setName('Notes folder')
			.setDesc('Where meeting notes are written.')
			.addText((t) =>
				t.setValue(this.plugin.settings.notesFolder).onChange(async (v) => {
					this.plugin.settings.notesFolder = v.trim() || 'Scuttlebutt/Notes';
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Audio folder')
			.setDesc('Where recordings are saved (when "Save audio" is on).')
			.addText((t) =>
				t.setValue(this.plugin.settings.audioFolder).onChange(async (v) => {
					this.plugin.settings.audioFolder = v.trim() || 'Scuttlebutt/Audio';
					await this.plugin.saveSettings();
				})
			);

		let datePreview: HTMLElement | null = null;
		new Setting(containerEl)
			.setName('Date format')
			.setDesc('Moment.js tokens for the note\'s date property.')
			.addText((t) =>
				t.setValue(this.plugin.settings.dateFormat).onChange(async (v) => {
					this.plugin.settings.dateFormat = v || DEFAULT_DATE_FORMAT;
					await this.plugin.saveSettings();
					if (datePreview) {
						datePreview.setText('Preview: ' + mmt().format(this.plugin.settings.dateFormat));
					}
				})
			)
			.then((s) => {
				datePreview = s.descEl.createDiv({ cls: 'mh-hint' });
				datePreview.setText('Preview: ' + mmt().format(this.plugin.settings.dateFormat || DEFAULT_DATE_FORMAT));
			});

		new Setting(containerEl)
			.setName('Save audio into the vault')
			.setDesc('Store the recording and embed a player in the note.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.saveAudio).onChange(async (v) => {
					this.plugin.settings.saveAudio = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Include transcript in note')
			.setDesc('Append the full transcript inside a collapsible callout.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.includeTranscript).onChange(async (v) => {
					this.plugin.settings.includeTranscript = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Include memo in note')
			.setDesc('Append your own notes inside a collapsible callout.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.includeMemo).onChange(async (v) => {
					this.plugin.settings.includeMemo = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Auto-open note after saving')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoOpenNote).onChange(async (v) => {
					this.plugin.settings.autoOpenNote = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName('Summary prompt').setHeading();
		let promptArea!: TextAreaComponent;
		new Setting(containerEl)
			.setName('System prompt')
			.setDesc('Sent as the system message. Use {{language}} where the language should appear.')
			.addTextArea((t) => {
				promptArea = t;
				t.setValue(this.plugin.settings.summaryPrompt).onChange(async (v) => {
					this.plugin.settings.summaryPrompt = v;
					await this.plugin.saveSettings();
				});
				t.inputEl.rows = 10;
				t.inputEl.addClass('mh-settings-textarea');
			})
			.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Reset to default')
					.onClick(async () => {
						this.plugin.settings.summaryPrompt = DEFAULT_SUMMARY_PROMPT;
						await this.plugin.saveSettings();
						// Update in place instead of this.display(), which would jump the
						// settings page back to the top.
						promptArea.setValue(DEFAULT_SUMMARY_PROMPT);
					})
			);
	}

	private endpointSection(
		containerEl: HTMLElement,
		opts: {
			heading: string;
			desc: string;
			endpointKey: 'sttEndpoint' | 'llmEndpoint';
			apiKeyKey: 'sttApiKey' | 'llmApiKey';
			modelKey: 'sttModel' | 'llmModel';
			modelsKey: 'sttModels' | 'llmModels';
			timeoutKey: 'sttTimeout' | 'llmTimeout';
		}
	): void {
		const settings = this.plugin.settings;
		new Setting(containerEl).setName(opts.heading).setDesc(opts.desc).setHeading();

		let urlText!: TextComponent;
		new Setting(containerEl)
			.setName('Endpoint URL')
			.setDesc('Base URL ending in /v1')
			.addText((t) => {
				urlText = t;
				t.setPlaceholder('http://localhost:8000/v1')
					.setValue(settings[opts.endpointKey])
					.onChange(async (v) => {
						settings[opts.endpointKey] = v.trim();
						await this.plugin.saveSettings();
					});
			})
			.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Reset to default URL')
					.onClick(async () => {
						settings[opts.endpointKey] = DEFAULT_SETTINGS[opts.endpointKey];
						await this.plugin.saveSettings();
						// Update the field in place — this.display() would rebuild the whole
						// settings tab and scroll it back to the top.
						urlText.setValue(settings[opts.endpointKey]);
					})
			);

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Leave empty if the server needs no auth.')
			.addText((t) => {
				t.inputEl.type = 'password';
				t.setPlaceholder('sk-…')
					.setValue(settings[opts.apiKeyKey])
					.onChange(async (v) => {
						settings[opts.apiKeyKey] = v.trim();
						await this.plugin.saveSettings();
					});
			});

		// Repopulate the model dropdown in place (no full re-render), so the test
		// status message beside the button stays visible instead of flashing away.
		let dropdown: DropdownComponent | null = null;
		const populate = (d: DropdownComponent) => {
			d.selectEl.empty();
			const models = settings[opts.modelsKey];
			if (models.length === 0) {
				d.addOption('', '— test the endpoint first —');
				d.setDisabled(true);
			} else {
				for (const m of models) d.addOption(m.id, m.name);
				const current = settings[opts.modelKey];
				const value = models.some((m) => m.id === current) ? current : models[0].id;
				settings[opts.modelKey] = value;
				d.setValue(value);
				d.setDisabled(false);
			}
		};

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Populated after a successful test.')
			.addDropdown((d) => {
				dropdown = d;
				populate(d);
				d.onChange(async (v) => {
					settings[opts.modelKey] = v;
					await this.plugin.saveSettings();
				});
			});

		const timeoutKey = opts.timeoutKey;
		let timeoutText!: TextComponent;
		new Setting(containerEl)
			.setName('Request timeout')
			.setDesc(
				'Seconds to wait for the server before giving up. Set 0 to wait ' +
					'indefinitely — useful for long recordings on a slow or busy server.'
			)
			.addText((t) => {
				timeoutText = t;
				t.inputEl.type = 'number';
				t.inputEl.min = '0';
				t.inputEl.step = '5';
				t.setValue(String(settings[timeoutKey])).onChange(async (v) => {
					const n = Number(v);
					if (Number.isFinite(n) && n >= 0) {
						settings[timeoutKey] = Math.floor(n);
						await this.plugin.saveSettings();
					}
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Reset to default')
					.onClick(async () => {
						settings[timeoutKey] = DEFAULT_SETTINGS[timeoutKey];
						await this.plugin.saveSettings();
						timeoutText.setValue(String(settings[timeoutKey]));
					})
			);

		const statusEl = createSpan({ cls: 'mh-test-status' });

		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Validates the endpoint and loads its model list (10s timeout).')
			.then((setting) => setting.controlEl.prepend(statusEl))
			.addButton((b) =>
				b.setButtonText('Test').onClick(async () => {
					b.setButtonText('Testing…').setDisabled(true);
					statusEl.setText('Testing…');
					statusEl.removeClass('is-ok', 'is-err');
					const result = await testEndpoint(settings[opts.endpointKey], settings[opts.apiKeyKey]);
					if (result.ok) {
						settings[opts.modelsKey] = result.models;
						if (!result.models.some((m) => m.id === settings[opts.modelKey])) {
							settings[opts.modelKey] = result.models[0]?.id ?? '';
						}
						statusEl.setText('✓ ' + result.message);
						statusEl.addClass('is-ok');
					} else {
						// Failed test: blank the dropdown, per spec.
						settings[opts.modelsKey] = [];
						settings[opts.modelKey] = '';
						statusEl.setText('✕ ' + result.message);
						statusEl.addClass('is-err');
					}
					await this.plugin.saveSettings();
					if (dropdown) populate(dropdown);
					b.setButtonText('Test').setDisabled(false);
				})
			);
	}
}
