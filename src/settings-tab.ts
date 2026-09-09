import {
	App,
	DropdownComponent,
	Notice,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	SettingGroupItem,
	TextAreaComponent,
	TextComponent,
} from 'obsidian';
import { AudioInput, DEFAULT_DATE_FORMAT, DEFAULT_SETTINGS, DEFAULT_SUMMARY_PROMPT, mmt } from './types';
import { testEndpoint } from './ai';
import type ScuttlebuttPlugin from './main';

interface EndpointOpts {
	endpointKey: 'sttEndpoint' | 'llmEndpoint';
	apiKeyKey: 'sttApiKey' | 'llmApiKey';
	modelKey: 'sttModel' | 'llmModel';
	modelsKey: 'sttModels' | 'llmModels';
	timeoutKey: 'sttTimeout' | 'llmTimeout';
}

export class ScuttlebuttSettingTab extends PluginSettingTab {
	private audioInputs: AudioInput[] = [];
	private deviceDropdown: DropdownComponent | null = null;
	private systemDeviceDropdown: DropdownComponent | null = null;
	// Model dropdowns by settings key, so the Test button can repopulate its own
	// endpoint's dropdown in place without a re-render (keeping the status visible).
	private modelDropdowns = new Map<string, DropdownComponent>();

	constructor(app: App, private plugin: ScuttlebuttPlugin) {
		super(app, plugin);
	}

	/**
	 * The declarative settings tree (Obsidian 1.13+). The four sections are
	 * navigable pages; plain binds are `control` definitions (so they show up in
	 * settings search), and the rows that need affordances the control model
	 * lacks — reset buttons, a masked field, dynamic dropdowns, the Test/Detect
	 * flows, a live preview — use the `render` escape hatch.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		// Seed the device pickers from the cached list so the saved input/system
		// devices show immediately on open, even before a fresh detect.
		if (this.audioInputs.length === 0) this.audioInputs = this.plugin.settings.audioDevices ?? [];
		return [
			{ type: 'page', name: 'Transcription', desc: 'Speech-to-text server and language.', items: this.transcriptionItems() },
			{ type: 'page', name: 'Summary', desc: 'Summary LLM server, reasoning, and output.', items: this.summaryItems() },
			{ type: 'page', name: 'Capture', desc: 'Recording input devices.', items: this.captureItems() },
			{ type: 'page', name: 'Output', desc: 'Where and how meeting notes are saved.', items: this.outputItems() },
		];
	}

	/** Normalize a few free-text keys (trim / fall back) before the default persist. */
	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		switch (key) {
			case 'sttLanguage':
				s.sttLanguage = String(value).trim();
				break;
			case 'notesFolder':
				s.notesFolder = String(value).trim() || 'Scuttlebutt/Notes';
				break;
			case 'audioFolder':
				s.audioFolder = String(value).trim() || 'Scuttlebutt/Audio';
				break;
			default:
				await super.setControlValue(key, value);
				return;
		}
		await this.plugin.saveSettings();
	}

	// ---- pages -----------------------------------------------------------

	private transcriptionItems(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: 'Server',
				items: this.endpointItems({
					endpointKey: 'sttEndpoint',
					apiKeyKey: 'sttApiKey',
					modelKey: 'sttModel',
					modelsKey: 'sttModels',
					timeoutKey: 'sttTimeout',
				}),
			},
			{
				name: 'Language',
				desc: 'Spoken language hint for transcription (e.g. en, zh, ja). Use "auto" to let the model detect.',
				control: { type: 'text', key: 'sttLanguage', placeholder: 'auto' },
			},
			{
				name: 'Identify speakers',
				desc:
					'Default for new recordings: ask the server to label who said what (diarization). ' +
					'You can flip it per recording in the sidebar. Requires a diarizing endpoint such as ' +
					'the WhisperX server; plain Whisper/vLLM will ignore it.',
				control: { type: 'toggle', key: 'sttDiarize' },
			},
		];
	}

	private summaryItems(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: 'Server',
				items: this.endpointItems({
					endpointKey: 'llmEndpoint',
					apiKeyKey: 'llmApiKey',
					modelKey: 'llmModel',
					modelsKey: 'llmModels',
					timeoutKey: 'llmTimeout',
				}),
			},
			{
				name: 'Reasoning effort',
				desc:
					'How hard a thinking model (e.g. Qwen3) reasons before answering. "Off" disables thinking — ' +
					'recommended for summaries, and required for models that would otherwise burn the whole ' +
					'token budget on <think>. Higher levels enable thinking and reserve more room for it; ' +
					'servers that support reasoning_effort (OpenAI-style) use the exact level.',
				control: {
					type: 'dropdown',
					key: 'reasoningEffort',
					options: {
						off: 'Off (no thinking)',
						low: 'Low',
						medium: 'Medium',
						high: 'High',
						xhigh: 'Extra high',
						max: 'Max',
					},
				},
			},
			{
				name: 'Stream summary',
				desc:
					'Show the summary as it generates, token by token, instead of waiting for the whole ' +
					"thing. Falls back to a single request on servers that can't stream. Model thinking, " +
					'when enabled, streams into a separate collapsible section.',
				control: { type: 'toggle', key: 'streamSummary' },
			},
			{
				name: 'Auto-summarize after transcription',
				desc: 'Generate the summary automatically once a transcript is ready.',
				control: { type: 'toggle', key: 'autoSummarize' },
			},
			{
				name: 'Suggest a title',
				desc: 'Let the model name the meeting (anarlog-style concise topic).',
				control: { type: 'toggle', key: 'generateTitle' },
			},
			{
				name: 'Suggest tags',
				desc: 'Let the model propose 3-5 tags, reusing your existing vault tags where relevant.',
				control: { type: 'toggle', key: 'generateTags' },
			},
			{
				name: 'Summary language',
				desc:
					'The language the summary and title are written in. Support depends on your LLM backend; ' +
					'English is recommended for the most reliable results.',
				render: (setting) => this.renderSummaryLanguage(setting),
			},
			{
				type: 'group',
				heading: 'Summary prompt',
				items: [
					{
						name: 'System prompt',
						desc: 'Sent as the system message. Use {{language}} where the language should appear.',
						render: (setting) => this.renderSummaryPrompt(setting),
					},
				],
			},
		];
	}

	private captureItems(): SettingDefinitionItem[] {
		return [
			{
				name: 'Input device',
				desc:
					'Which microphone/input to record. To capture system audio on macOS, install a loopback ' +
					'device (e.g. BlackHole) and record from an aggregate device that includes it, then select it here.',
				render: (setting) => this.renderDevicePicker(setting, 'inputDeviceId', 'System default', 'input'),
			},
			{
				name: 'System audio device',
				desc:
					'Optional second input, recorded alongside the mic and mixed into one track. Pick a ' +
					'loopback device that carries system/meeting audio (e.g. BlackHole on macOS). ' +
					'Leave "Off" to record the microphone only.',
				render: (setting) => this.renderDevicePicker(setting, 'systemAudioDeviceId', 'Off', 'system'),
			},
			{
				name: 'Capture system audio',
				desc:
					'Alternative to the device above: mix in system audio via a screen-share prompt. ' +
					'Works on some platforms but not reliably on macOS — if no system audio is captured ' +
					'you will be told, and recording continues with the microphone. On macOS, prefer the ' +
					'"System audio device" option above.',
				control: { type: 'toggle', key: 'captureSystemAudio' },
			},
		];
	}

	private outputItems(): SettingDefinitionItem[] {
		return [
			{
				name: 'Notes folder',
				desc: 'Where meeting notes are written.',
				control: { type: 'text', key: 'notesFolder', placeholder: 'Scuttlebutt/Notes' },
			},
			{
				name: 'Audio folder',
				desc: 'Where recordings are saved (when "Save audio" is on).',
				control: { type: 'text', key: 'audioFolder', placeholder: 'Scuttlebutt/Audio' },
			},
			{
				name: 'Date format',
				desc: "Moment.js tokens for the note's date property.",
				render: (setting) => this.renderDateFormat(setting),
			},
			{
				name: 'Save audio into the vault',
				desc: 'Store the recording and embed a player in the note.',
				control: { type: 'toggle', key: 'saveAudio' },
			},
			{
				name: 'Include transcript in note',
				desc: 'Append the full transcript inside a collapsible callout.',
				control: { type: 'toggle', key: 'includeTranscript' },
			},
			{
				name: 'Include memo in note',
				desc: 'Append your own notes inside a collapsible callout.',
				control: { type: 'toggle', key: 'includeMemo' },
			},
			{
				name: 'Auto-open note after saving',
				control: { type: 'toggle', key: 'autoOpenNote' },
			},
		];
	}

	// ---- render escape hatches ------------------------------------------

	private endpointItems(opts: EndpointOpts): SettingGroupItem[] {
		return [
			{
				name: 'Endpoint URL',
				desc: 'Base URL ending in /v1',
				render: (setting) => this.renderEndpointUrl(setting, opts),
			},
			{
				name: 'API key',
				desc: 'Leave empty if the server needs no auth.',
				render: (setting) => this.renderApiKey(setting, opts),
			},
			{
				name: 'Model',
				desc: 'Populated after a successful test.',
				render: (setting) => this.renderModel(setting, opts),
			},
			{
				name: 'Request timeout',
				desc:
					'Seconds to wait for the server before giving up. Set 0 to wait ' +
					'indefinitely — useful for long recordings on a slow or busy server.',
				render: (setting) => this.renderTimeout(setting, opts),
			},
			{
				name: 'Test connection',
				desc: 'Validates the endpoint and loads its model list (10s timeout).',
				render: (setting) => this.renderTest(setting, opts),
			},
		];
	}

	private renderEndpointUrl(setting: Setting, opts: EndpointOpts): void {
		const settings = this.plugin.settings;
		let urlText!: TextComponent;
		setting
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
						urlText.setValue(settings[opts.endpointKey]);
					})
			);
	}

	private renderApiKey(setting: Setting, opts: EndpointOpts): void {
		const settings = this.plugin.settings;
		setting.addText((t) => {
			t.inputEl.type = 'password';
			t.setPlaceholder('sk-…')
				.setValue(settings[opts.apiKeyKey])
				.onChange(async (v) => {
					settings[opts.apiKeyKey] = v.trim();
					await this.plugin.saveSettings();
				});
		});
	}

	private renderModel(setting: Setting, opts: EndpointOpts): void {
		setting.addDropdown((d) => {
			this.modelDropdowns.set(opts.modelKey, d);
			this.populateModelDropdown(d, opts);
			d.onChange(async (v) => {
				this.plugin.settings[opts.modelKey] = v;
				await this.plugin.saveSettings();
			});
		});
	}

	/** Fill a model dropdown from the discovered model list (in place, no re-render). */
	private populateModelDropdown(d: DropdownComponent, opts: EndpointOpts): void {
		const settings = this.plugin.settings;
		d.selectEl.empty();
		const models = settings[opts.modelsKey];
		if (models.length === 0) {
			d.addOption('', '— test the endpoint first —');
			d.setDisabled(true);
			return;
		}
		for (const m of models) d.addOption(m.id, m.name);
		const current = settings[opts.modelKey];
		const value = models.some((m) => m.id === current) ? current : models[0].id;
		settings[opts.modelKey] = value;
		d.setValue(value);
		d.setDisabled(false);
	}

	private renderTimeout(setting: Setting, opts: EndpointOpts): void {
		const settings = this.plugin.settings;
		const timeoutKey = opts.timeoutKey;
		let timeoutText!: TextComponent;
		let timeoutWarn: HTMLElement | null = null;
		const updateTimeoutWarn = () => {
			if (!timeoutWarn) return;
			const n = settings[timeoutKey];
			timeoutWarn.toggleClass('mh-hidden', !(Number.isFinite(n) && n > 0 && n < 20));
		};
		setting
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
			);
		timeoutWarn = setting.descEl.createDiv({ cls: 'mh-warn' });
		timeoutWarn.setText('A very low timeout (under 20s) may abort requests before a slow server responds.');
		updateTimeoutWarn();
	}

	private renderTest(setting: Setting, opts: EndpointOpts): void {
		const settings = this.plugin.settings;
		const statusEl = createSpan({ cls: 'mh-test-status' });
		setting.controlEl.prepend(statusEl);
		setting.addButton((b) =>
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
				// Refresh the model dropdown in place so the status message stays visible.
				const modelDropdown = this.modelDropdowns.get(opts.modelKey);
				if (modelDropdown) this.populateModelDropdown(modelDropdown, opts);
				b.setButtonText('Test').setDisabled(false);
			})
		);
	}

	private renderSummaryLanguage(setting: Setting): void {
		let langText!: TextComponent;
		setting
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
	}

	private renderSummaryPrompt(setting: Setting): void {
		let promptArea!: TextAreaComponent;
		setting
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
						promptArea.setValue(DEFAULT_SUMMARY_PROMPT);
					})
			);
	}

	private renderDateFormat(setting: Setting): void {
		const preview = setting.descEl.createDiv({ cls: 'mh-hint' });
		const refresh = () =>
			preview.setText('Preview: ' + mmt().format(this.plugin.settings.dateFormat || DEFAULT_DATE_FORMAT));
		setting.addText((t) =>
			t.setValue(this.plugin.settings.dateFormat).onChange(async (v) => {
				this.plugin.settings.dateFormat = v || DEFAULT_DATE_FORMAT;
				await this.plugin.saveSettings();
				refresh();
			})
		);
		refresh();
	}

	private renderDevicePicker(
		setting: Setting,
		key: 'inputDeviceId' | 'systemAudioDeviceId',
		firstLabel: string,
		which: 'input' | 'system'
	): void {
		setting
			.addDropdown((d) => {
				if (which === 'input') this.deviceDropdown = d;
				else this.systemDeviceDropdown = d;
				this.populateDeviceDropdown(d, key, firstLabel);
				d.onChange(async (v) => {
					this.plugin.settings[key] = v;
					await this.plugin.saveSettings();
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon('refresh-cw')
					.setTooltip('Detect input devices')
					.onClick(() => void this.detectDevices())
			);
	}

	/** Fill a device dropdown from the detected inputs. */
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

	/** Request mic permission (to unlock device labels), then list audio inputs. */
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
			// Cache the list so the pickers show the saved selection after a reload.
			this.plugin.settings.audioDevices = this.audioInputs;
			await this.plugin.saveSettings();
			new Notice(`Found ${this.audioInputs.length} input device${this.audioInputs.length === 1 ? '' : 's'}.`);
		} catch {
			this.audioInputs = [];
		}
		// Repopulate the device dropdowns in place (no full re-render).
		if (this.deviceDropdown) this.populateDeviceDropdown(this.deviceDropdown, 'inputDeviceId', 'System default');
		if (this.systemDeviceDropdown) {
			this.populateDeviceDropdown(this.systemDeviceDropdown, 'systemAudioDeviceId', 'Off');
		}
	}
}
