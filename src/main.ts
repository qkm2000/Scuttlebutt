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

import { Notice, Plugin, TFile, normalizePath, requestUrl } from 'obsidian';
import {
	applyTemplate,
	calloutBlock,
	DEFAULT_REASONING_BUDGETS,
	errorMessage,
	formatDuration,
	isNewerVersion,
	isRecord,
	recordedMs,
	sanitizeFileName,
	str,
	structureSummary,
	todayStamp,
	yamlString,
} from './utils';
import {
	DEFAULT_DATE_FORMAT,
	DEFAULT_FILENAME_TEMPLATE,
	DEFAULT_SETTINGS,
	MeetingSession,
	mmt,
	newSession,
	ScuttlebuttSettings,
	SessionStatus,
	VIEW_TYPE_SCUTTLEBUTT,
} from './types';
import { MeetingRecorder } from './recorder';
import { AIService } from './ai';
import { ScuttlebuttView } from './view';
import { ScuttlebuttSettingTab } from './settings-tab';

// API keys live in Obsidian's secret storage (OS keychain), not data.json.
const STT_KEY_ID = 'scuttlebutt-stt-api-key';
const LLM_KEY_ID = 'scuttlebutt-llm-api-key';

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
	// Cleared if secret storage is unavailable, so we fall back to keeping the keys
	// in data.json rather than losing them.
	private secretStorageOk = true;

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
				if (can && !checking) void this.runPipeline();
				return can;
			},
		});
		this.addCommand({
			id: 'save-note',
			name: 'Save meeting note',
			checkCallback: (checking) => {
				const can = !!(this.session.summary || this.session.transcript) && !this.isBusy();
				if (can && !checking) void this.saveNote();
				return can;
			},
		});

		this.addSettingTab(new ScuttlebuttSettingTab(this.app, this));

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('mh-statusbar', 'mh-hidden');

		// Check for a newer release once the workspace is ready (non-blocking, throttled).
		this.app.workspace.onLayoutReady(() => void this.maybeCheckForUpdate());
	}

	onunload(): void {
		this.recorder.abort();
		this.stopStatusBarTimer();
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<ScuttlebuttSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// reasoningBudgets is a nested object: clone the defaults and merge any saved
		// values so editing it never mutates DEFAULT_SETTINGS, and older data (missing
		// some levels) still gets every level filled in.
		this.settings.reasoningBudgets = Object.assign(
			{},
			DEFAULT_REASONING_BUDGETS,
			saved?.reasoningBudgets
		);
		// API keys live in secret storage. Load them into the in-memory settings (which
		// AIService reads), migrating any plaintext key left in data.json by older versions.
		let migrated = false;
		const loadKey = (id: string, plaintext: string): string => {
			try {
				const secret = this.app.secretStorage.getSecret(id);
				if (secret !== null) return secret;
				if (plaintext) {
					this.app.secretStorage.setSecret(id, plaintext);
					migrated = true;
				}
				return plaintext;
			} catch {
				this.secretStorageOk = false;
				return plaintext;
			}
		};
		this.settings.sttApiKey = loadKey(STT_KEY_ID, this.settings.sttApiKey);
		this.settings.llmApiKey = loadKey(LLM_KEY_ID, this.settings.llmApiKey);
		this.ai = new AIService(this.settings);
		// Re-save once after a migration so the plaintext key is scrubbed from data.json.
		if (migrated && this.secretStorageOk) await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		// Persist only. AIService holds `settings` by reference (mutated in place), so it needs
		// no rebuild; and the sidebar reads session state, not settings, so no re-render is
		// needed here. Re-rendering per keystroke rebuilt the audio Blob and reset playback.
		// API keys are blanked before persisting so they never touch data.json (unless secret
		// storage is unavailable, in which case we keep them to avoid data loss).
		const data: ScuttlebuttSettings = this.secretStorageOk
			? { ...this.settings, sttApiKey: '', llmApiKey: '' }
			: this.settings;
		await this.saveData(data);
	}

	/** Store an API key in secret storage and mirror it into the in-memory settings. */
	setApiKey(which: 'stt' | 'llm', value: string): void {
		const id = which === 'stt' ? STT_KEY_ID : LLM_KEY_ID;
		if (which === 'stt') this.settings.sttApiKey = value;
		else this.settings.llmApiKey = value;
		try {
			this.app.secretStorage.setSecret(id, value);
		} catch {
			this.secretStorageOk = false;
		}
	}

	/**
	 * Ask GitHub for the latest release at most once a day, remember it, and — if it
	 * is newer than the installed version — show a one-time notice. Silent on failure;
	 * a missed check should never nag. Skipped entirely when the user opts out.
	 */
	async maybeCheckForUpdate(): Promise<void> {
		const s = this.settings;
		if (!s.updateCheckEnabled) return;
		const DAY_MS = 24 * 60 * 60 * 1000;
		if (Date.now() - s.lastUpdateCheck >= DAY_MS) {
			s.lastUpdateCheck = Date.now();
			await this.saveSettings();
			try {
				const res = await requestUrl({
					url: 'https://api.github.com/repos/qkm2000/Scuttlebutt/releases/latest',
					headers: { Accept: 'application/vnd.github+json' },
					throw: false,
				});
				const data: unknown = res.json;
				if (isRecord(data)) {
					const tag = str(data.tag_name).replace(/^v/i, '').trim();
					if (tag) {
						s.latestKnownVersion = tag;
						await this.saveSettings();
					}
				}
			} catch {
				// network or parse failure — stay quiet
			}
		}
		this.notifyIfUpdate();
	}

	/** Show an update notice with a jump-to-update action, if a newer version is known. */
	private notifyIfUpdate(): void {
		const latest = this.settings.latestKnownVersion;
		if (!latest || !isNewerVersion(latest, this.manifest.version)) return;
		const frag = createFragment((f) => {
			f.appendText(`Scuttlebutt ${latest} is available (you have ${this.manifest.version}). `);
			const link = f.createEl('a', { text: 'Update', href: '#' });
			link.addEventListener('click', (e) => {
				e.preventDefault();
				this.openCommunityPlugins();
			});
		});
		new Notice(frag, 15000);
	}

	/** Open Settings -> Community plugins so the user can update from there. */
	openCommunityPlugins(): void {
		const setting = (
			this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }
		).setting;
		setting?.open();
		setting?.openTabById('community-plugins');
	}

	async activateView(): Promise<void> {
		try {
			const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCUTTLEBUTT);
			if (existing.length > 0) {
				await this.app.workspace.revealLeaf(existing[0]);
				return;
			}
			const leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) {
				new Notice('Could not open the Scuttlebutt sidebar.');
				return;
			}
			await leaf.setViewState({ type: VIEW_TYPE_SCUTTLEBUTT, active: true });
			await this.app.workspace.revealLeaf(leaf);
		} catch (err) {
			console.error('Scuttlebutt: failed to open sidebar', err);
			new Notice('Failed to open sidebar: ' + errorMessage(err));
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
		} catch (err) {
			new Notice('Microphone access failed: ' + errorMessage(err));
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
		void this.runPipeline();
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
			void this.runPipeline();
		} catch (err) {
			new Notice('Could not read audio file: ' + errorMessage(err));
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
			void this.runPipeline();
		} catch (err) {
			new Notice('Could not read audio file: ' + errorMessage(err));
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
		} catch (err) {
			if (controller.signal.aborted) {
				this.finishCancelled();
				return false;
			}
			s.error = errorMessage(err);
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
		} catch (err) {
			if (controller.signal.aborted) {
				this.finishCancelled();
				return;
			}
			this.setStatus(s.summary ? 'ready' : 'recorded');
			this.setProgress('', 0);
			this.refreshViews();
			new Notice(`${piece === 'title' ? 'Title' : 'Tag'} generation failed: ${errorMessage(err)}`);
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
			} catch (err) {
				if (controller.signal.aborted) {
					this.finishCancelled();
					return;
				}
				s.error = errorMessage(err);
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
				void this.app.workspace.openLinkText(notePath, '', true);
			}
			window.setTimeout(() => this.clearProgressIfIdle(), 4000);
		} catch (err) {
			s.error = 'Could not save note: ' + errorMessage(err);
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
		const base = sanitizeFileName(
			applyTemplate(this.settings.filenameTemplate || DEFAULT_FILENAME_TEMPLATE, {
				date: todayStamp(now),
				title,
			})
		);
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
		if (this.statusBarEl) this.statusBarEl.addClass('mh-hidden');
	}

	private updateStatusBar(): void {
		if (!this.statusBarEl) return;
		if (this.session.status === 'recording') {
			this.statusBarEl.removeClass('mh-hidden');
			this.statusBarEl.empty();
			this.statusBarEl.createSpan({ cls: 'mh-sb-dot' });
			const t = formatDuration(recordedMs(this.session.activeMs, this.session.segmentStartedAt, Date.now()));
			this.statusBarEl.createSpan({ text: ' ' + t + (this.session.paused ? ' (paused)' : '') });
			this.statusBarEl.onclick = () => this.activateView();
		} else {
			this.statusBarEl.addClass('mh-hidden');
		}
	}
}
