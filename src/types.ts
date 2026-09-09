import { moment } from 'obsidian';
import { ReasoningLevel } from './utils';

// Obsidian re-exports `moment` as a callable at runtime, but its bundled type is the
// namespace (no call signature), so `tsc` rejects `moment(...)`. Alias to the call form.
export const mmt = moment as unknown as (inp?: string | number | Date) => { format(fmt: string): string };

export interface ModelOption {
	id: string;
	name: string;
}

/** A cached audio input device, persisted so the picker survives a reload without re-detecting. */
export interface AudioInput {
	deviceId: string;
	label: string;
}

export interface ScuttlebuttSettings {
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

export const DEFAULT_DATE_FORMAT = 'dddd, MMMM Do YYYY, h:mm:ss a';

export const DEFAULT_SUMMARY_PROMPT = `# General Instructions

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

export const DEFAULT_SETTINGS: ScuttlebuttSettings = {
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

export type SessionStatus =
	| 'idle'
	| 'recording'
	| 'recorded'
	| 'transcribing'
	| 'summarizing'
	| 'ready'
	| 'saving'
	| 'error';

export type ReviewTab = 'summary' | 'transcript' | 'memo';

export interface MeetingSession {
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

export function newSession(
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

export const VIEW_TYPE_SCUTTLEBUTT = 'scuttlebutt-view';
export const AUDIO_EXTENSIONS = ['webm', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'mp4', 'mpga', 'oga'];
