import { Component, ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import { formatDuration, normalizeTag, recordedMs, ReasoningLevel } from './utils';
import { AUDIO_EXTENSIONS, MeetingSession, ReviewTab, VIEW_TYPE_SCUTTLEBUTT } from './types';
import { ConfirmModal, FileSuggestModal, SaveChoiceModal } from './modals';
import type ScuttlebuttPlugin from './main';

export class ScuttlebuttView extends ItemView {
	private timer: number | null = null;
	private timerEl: HTMLElement | null = null;
	private audioUrl: string | null = null;
	private audioUrlFor: ArrayBuffer | null = null;
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
		this.audioUrlFor = null;
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
		// Note: the audio object URL is intentionally NOT revoked here — it's cached by
		// data reference (see renderCapture) so re-renders don't rebuild the Blob or reset
		// playback. It's revoked when the data changes or the view closes.
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
				// Reuse the object URL unless the underlying audio actually changed, so a
				// re-render doesn't rebuild a large Blob or reset playback position.
				if (!this.audioUrl || this.audioUrlFor !== s.audioData) {
					this.revokeAudioUrl();
					this.audioUrl = URL.createObjectURL(new Blob([s.audioData], { type: s.audioMime }));
					this.audioUrlFor = s.audioData;
				}
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
