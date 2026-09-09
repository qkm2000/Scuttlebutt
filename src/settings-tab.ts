import { App, DropdownComponent, Notice, PluginSettingTab, Setting, TextAreaComponent, TextComponent } from 'obsidian';
import { AudioInput, DEFAULT_DATE_FORMAT, DEFAULT_SETTINGS, DEFAULT_SUMMARY_PROMPT, mmt } from './types';
import { ReasoningLevel } from './utils';
import { testEndpoint } from './ai';
import type ScuttlebuttPlugin from './main';

type SettingsTab = 'transcription' | 'summary' | 'capture' | 'output';

export class ScuttlebuttSettingTab extends PluginSettingTab {
	private audioInputs: AudioInput[] = [];
	private deviceDropdown: DropdownComponent | null = null;
	private systemDeviceDropdown: DropdownComponent | null = null;
	private activeSettingsTab: SettingsTab = 'transcription';

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

		// Group settings into tabs so the page is scannable instead of one long scroll.
		const defs: { id: SettingsTab; label: string; render: (el: HTMLElement) => void }[] = [
			{ id: 'transcription', label: 'Transcription', render: (el) => this.renderTranscriptionSettings(el) },
			{ id: 'summary', label: 'Summary', render: (el) => this.renderSummarySettings(el) },
			{ id: 'capture', label: 'Capture', render: (el) => this.renderCaptureSettings(el) },
			{ id: 'output', label: 'Output', render: (el) => this.renderOutputSettings(el) },
		];
		const bar = containerEl.createDiv('mh-settings-tabs');
		const panels = new Map<SettingsTab, HTMLElement>();
		const buttons = new Map<SettingsTab, HTMLElement>();
		const activate = (id: SettingsTab) => {
			this.activeSettingsTab = id;
			buttons.forEach((btn, tid) => btn.toggleClass('is-active', tid === id));
			panels.forEach((panel, tid) => (panel.style.display = tid === id ? '' : 'none'));
		};
		for (const def of defs) {
			const btn = bar.createEl('button', { cls: 'mh-settings-tab', text: def.label });
			btn.onclick = () => activate(def.id);
			buttons.set(def.id, btn);
			const panel = containerEl.createDiv('mh-settings-panel');
			panels.set(def.id, panel);
			def.render(panel);
		}
		activate(this.activeSettingsTab);
	}

	private renderTranscriptionSettings(containerEl: HTMLElement): void {
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
	}

	private renderSummarySettings(containerEl: HTMLElement): void {
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

		let langText!: TextComponent;
		new Setting(containerEl)
			.setName('Summary language')
			.setDesc(
				'The language the summary and title are written in. Support depends on your LLM backend; ' +
					'English is recommended for the most reliable results.'
			)
			.addText((t) => {
				langText = t;
				t.setValue(this.plugin.settings.language).onChange(async (v) => {
					this.plugin.settings.language = v.trim() || 'English';
					await this.plugin.saveSettings();
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Reset to English')
					.onClick(async () => {
						this.plugin.settings.language = 'English';
						await this.plugin.saveSettings();
						langText.setValue('English');
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

	private renderCaptureSettings(containerEl: HTMLElement): void {
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
	}

	private renderOutputSettings(containerEl: HTMLElement): void {
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
		let timeoutWarn: HTMLElement | null = null;
		const updateTimeoutWarn = () => {
			if (!timeoutWarn) return;
			const n = settings[timeoutKey];
			const low = Number.isFinite(n) && n > 0 && n < 20;
			timeoutWarn.style.display = low ? '' : 'none';
		};
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
						updateTimeoutWarn();
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
						updateTimeoutWarn();
					})
			)
			.then((s) => {
				timeoutWarn = s.descEl.createDiv({ cls: 'mh-warn' });
				timeoutWarn.setText('A very low timeout (under 20s) may abort requests before a slow server responds.');
				updateTimeoutWarn();
			});

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
