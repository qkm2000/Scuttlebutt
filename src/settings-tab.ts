import {
	App,
	DropdownComponent,
	Notice,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	TextAreaComponent,
	TextComponent,
} from 'obsidian';
import {
	AudioInput,
	DEFAULT_DATE_FORMAT,
	DEFAULT_FILENAME_TEMPLATE,
	DEFAULT_SETTINGS,
	DEFAULT_SUMMARY_PROMPT,
	mmt,
} from './types';
import {
	applyTemplate,
	DEFAULT_REASONING_BUDGETS,
	DEFAULT_SUMMARY_MAX_TOKENS,
	isNewerVersion,
	ReasoningLevel,
	sanitizeFileName,
	todayStamp,
} from './utils';
import { testEndpoint } from './ai';
import type ScuttlebuttPlugin from './main';

interface EndpointOpts {
	endpointKey: 'sttEndpoint' | 'llmEndpoint';
	apiKeyKey: 'sttApiKey' | 'llmApiKey';
	modelKey: 'sttModel' | 'llmModel';
	modelsKey: 'sttModels' | 'llmModels';
	timeoutKey: 'sttTimeout' | 'llmTimeout';
}

type SettingsTab = 'general' | 'transcription' | 'summary' | 'capture' | 'output';
interface TabHandle {
	btn: HTMLElement;
	panel: HTMLElement;
}

export class ScuttlebuttSettingTab extends PluginSettingTab {
	private audioInputs: AudioInput[] = [];
	private deviceDropdown: DropdownComponent | null = null;
	private systemDeviceDropdown: DropdownComponent | null = null;
	// Model dropdowns by settings key, so the Test button can repopulate its own
	// endpoint's dropdown in place without a re-render (keeping the status visible).
	private modelDropdowns = new Map<string, DropdownComponent>();
	// Remembered across opens so reopening settings lands on the last-used tab.
	private activeTab: SettingsTab = 'general';

	constructor(app: App, private plugin: ScuttlebuttPlugin) {
		super(app, plugin);
	}

	/**
	 * The declarative settings entry point (Obsidian 1.13+). The whole settings
	 * surface is a browser-style tabbed UI (Transcription / Summary / Capture /
	 * Output) built imperatively in one `render` escape hatch: the declarative
	 * control model has no tab affordance, and tabs switch faster than navigable
	 * pages. `display()` stays removed (deprecated since 1.13.0).
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		// Seed the device pickers from the cached list so the saved input/system
		// devices show immediately on open, even before a fresh detect.
		if (this.audioInputs.length === 0) this.audioInputs = this.plugin.settings.audioDevices ?? [];
		// A `render` escape hatch only fires when it lives inside a group/page, not
		// bare at the top level — so host the whole tabbed UI in one headless group.
		return [
			{
				type: 'group',
				cls: 'mh-settings-group',
				items: [{ name: 'Scuttlebutt settings', searchable: false, render: (setting) => this.renderTabbedUi(setting) }],
			},
		];
	}

	// ---- tabbed shell ----------------------------------------------------

	private renderTabbedUi(setting: Setting): void {
		// Build the tabbed UI INTO the row element Obsidian renders: it keeps a
		// reference to settingEl and moves that element into the visible pane, so
		// sibling additions or removing it never stick — only children of settingEl
		// survive. Clear the default name/desc/control, then own the element.
		const host = setting.settingEl;
		host.empty();
		host.addClass('mh-settings-host');
		const root = host.createDiv({ cls: 'mh-settings' });
		const tabBar = root.createDiv({ cls: 'mh-settings-tabs' });
		const body = root.createDiv({ cls: 'mh-settings-body' });

		const tabs: { id: SettingsTab; label: string; build: (el: HTMLElement) => void }[] = [
			{ id: 'general', label: 'General', build: (el) => this.buildGeneral(el) },
			{ id: 'transcription', label: 'Transcription', build: (el) => this.buildTranscription(el) },
			{ id: 'summary', label: 'Summary', build: (el) => this.buildSummary(el) },
			{ id: 'capture', label: 'Capture', build: (el) => this.buildCapture(el) },
			{ id: 'output', label: 'Output', build: (el) => this.buildOutput(el) },
		];

		const handles = new Map<SettingsTab, TabHandle>();
		for (const tab of tabs) {
			const btn = tabBar.createEl('button', {
				cls: 'mh-settings-tab',
				text: tab.label,
				attr: { type: 'button' },
			});
			const panel = body.createDiv({ cls: 'mh-settings-panel' });
			tab.build(panel);
			handles.set(tab.id, { btn, panel });
			btn.addEventListener('click', () => this.selectTab(tab.id, handles));
		}
		if (!tabs.some((t) => t.id === this.activeTab)) this.activeTab = 'general';
		this.selectTab(this.activeTab, handles);
	}

	private selectTab(id: SettingsTab, handles: Map<SettingsTab, TabHandle>): void {
		this.activeTab = id;
		handles.forEach(({ btn, panel }, pid) => {
			const active = pid === id;
			btn.toggleClass('is-active', active);
			panel.toggleClass('mh-hidden', !active);
		});
	}

	private buildGeneral(el: HTMLElement): void {
		const version = this.plugin.manifest.version;
		const latest = this.plugin.settings.latestKnownVersion;
		const hasUpdate = !!latest && isNewerVersion(latest, version);

		new Setting(el).setName('Updates').setHeading();
		const status = new Setting(el).setName(`Scuttlebutt v${version}`);
		if (hasUpdate) {
			status.setDesc(`Update available: ${latest}`);
			status.addButton((b) =>
				b
					.setButtonText('Update')
					.setCta()
					.onClick(() => this.plugin.openCommunityPlugins())
			);
		} else {
			status.setDesc('Up to date.');
		}
		new Setting(el)
			.setName('Notify me about updates')
			.setDesc('Check GitHub for a newer version at most once a day and show a notice when one is available.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.updateCheckEnabled).onChange(async (v) => {
					this.plugin.settings.updateCheckEnabled = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(el).setName('About').setHeading();
		new Setting(el)
			.setName('GitHub')
			.setDesc('Source code, releases, and issues.')
			.addButton((b) =>
				b.setButtonText('Open').onClick(() => window.open('https://github.com/qkm2000/Scuttlebutt'))
			);
	}

	// ---- small imperative row helpers ------------------------------------

	private toggleRow(
		el: HTMLElement,
		name: string,
		desc: string,
		get: () => boolean,
		set: (v: boolean) => void
	): Setting {
		const setting = new Setting(el).setName(name);
		if (desc) setting.setDesc(desc);
		setting.addToggle((t) =>
			t.setValue(get()).onChange(async (v) => {
				set(v);
				await this.plugin.saveSettings();
			})
		);
		return setting;
	}

	private textRow(
		el: HTMLElement,
		name: string,
		desc: string,
		get: () => string,
		set: (v: string) => void,
		opts?: { placeholder?: string; resetTo?: string }
	): Setting {
		let text!: TextComponent;
		const setting = new Setting(el).setName(name).setDesc(desc).addText((t) => {
			text = t;
			if (opts?.placeholder) t.setPlaceholder(opts.placeholder);
			t.setValue(get()).onChange(async (v) => {
				set(v);
				await this.plugin.saveSettings();
			});
		});
		if (opts?.resetTo !== undefined) {
			const resetTo = opts.resetTo;
			setting.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Reset to default')
					.onClick(async () => {
						set(resetTo);
						await this.plugin.saveSettings();
						text.setValue(get());
					})
			);
		}
		return setting;
	}

	private numberRow(
		el: HTMLElement,
		name: string,
		desc: string,
		get: () => number,
		set: (v: number) => void,
		opts?: { min?: number; step?: number; resetTo?: number }
	): Setting {
		const min = opts?.min ?? 0;
		let text!: TextComponent;
		const setting = new Setting(el).setName(name);
		if (desc) setting.setDesc(desc);
		setting.addText((t) => {
			text = t;
			t.inputEl.type = 'number';
			t.inputEl.min = String(min);
			if (opts?.step) t.inputEl.step = String(opts.step);
			// Guard against corrupt values: only persist a finite number at/above the floor.
			t.setValue(String(get())).onChange(async (v) => {
				const n = Number(v);
				if (Number.isFinite(n) && n >= min) {
					set(Math.floor(n));
					await this.plugin.saveSettings();
				}
			});
		});
		if (opts?.resetTo !== undefined) {
			const resetTo = opts.resetTo;
			setting.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Reset to default')
					.onClick(async () => {
						set(resetTo);
						await this.plugin.saveSettings();
						text.setValue(String(get()));
					})
			);
		}
		return setting;
	}

	/** A `<details>` section, collapsed by default, with a heading-styled summary. */
	private collapsibleSection(el: HTMLElement, title: string): HTMLElement {
		const details = el.createEl('details', { cls: 'mh-collapsible' });
		details.createEl('summary', { cls: 'mh-collapsible-summary', text: title });
		return details.createDiv({ cls: 'mh-collapsible-body' });
	}

	// ---- tab panels ------------------------------------------------------

	private buildTranscription(el: HTMLElement): void {
		const s = this.plugin.settings;
		this.buildServer(el, {
			endpointKey: 'sttEndpoint',
			apiKeyKey: 'sttApiKey',
			modelKey: 'sttModel',
			modelsKey: 'sttModels',
			timeoutKey: 'sttTimeout',
		});
		this.textRow(
			el,
			'Language',
			'Spoken language hint for transcription (e.g. en, zh, ja). Use "auto" to let the model detect.',
			() => s.sttLanguage,
			(v) => {
				s.sttLanguage = v.trim();
			},
			{ placeholder: 'auto', resetTo: DEFAULT_SETTINGS.sttLanguage }
		);
		this.toggleRow(
			el,
			'Identify speakers',
			'Default for new recordings: ask the server to label who said what (diarization). ' +
				'You can flip it per recording in the sidebar. Requires a diarizing endpoint such as ' +
				'the WhisperX server; plain Whisper/vLLM will ignore it.',
			() => s.sttDiarize,
			(v) => {
				s.sttDiarize = v;
			}
		);
	}

	private buildSummary(el: HTMLElement): void {
		const s = this.plugin.settings;
		this.buildServer(el, {
			endpointKey: 'llmEndpoint',
			apiKeyKey: 'llmApiKey',
			modelKey: 'llmModel',
			modelsKey: 'llmModels',
			timeoutKey: 'llmTimeout',
		});
		new Setting(el)
			.setName('Reasoning effort')
			.setDesc(
				'How hard a thinking model (e.g. Qwen3) reasons before answering. "Off" disables thinking — ' +
					'recommended for summaries, and required for models that would otherwise burn the whole ' +
					'token budget on <think>. Higher levels enable thinking and reserve more room for it; ' +
					'servers that support reasoning_effort (OpenAI-style) use the exact level.'
			)
			.addDropdown((d) => {
				d.addOptions({
					off: 'Off (no thinking)',
					low: 'Low',
					medium: 'Medium',
					high: 'High',
					xhigh: 'Extra high',
					max: 'Max',
				});
				d.setValue(s.reasoningEffort);
				d.onChange(async (v) => {
					s.reasoningEffort = v as ReasoningLevel;
					await this.plugin.saveSettings();
				});
			});
		this.toggleRow(
			el,
			'Stream summary',
			'Show the summary as it generates, token by token, instead of waiting for the whole ' +
				"thing. Falls back to a single request on servers that can't stream. Model thinking, " +
				'when enabled, streams into a separate collapsible section.',
			() => s.streamSummary,
			(v) => {
				s.streamSummary = v;
			}
		);
		this.toggleRow(
			el,
			'Auto-summarize after transcription',
			'Generate the summary automatically once a transcript is ready.',
			() => s.autoSummarize,
			(v) => {
				s.autoSummarize = v;
			}
		);
		this.toggleRow(
			el,
			'Suggest a title',
			'Let the model name the meeting (anarlog-style concise topic).',
			() => s.generateTitle,
			(v) => {
				s.generateTitle = v;
			}
		);
		this.toggleRow(
			el,
			'Suggest tags',
			'Let the model propose 3-5 tags, reusing your existing vault tags where relevant.',
			() => s.generateTags,
			(v) => {
				s.generateTags = v;
			}
		);
		this.renderSummaryLanguage(
			new Setting(el)
				.setName('Summary language')
				.setDesc(
					'The language the summary and title are written in. Support depends on your LLM backend; ' +
						'English is recommended for the most reliable results.'
				)
		);
		new Setting(el).setName('Summary prompt').setHeading();
		this.renderSummaryPrompt(
			new Setting(el)
				.setName('System prompt')
				.setDesc('Sent as the system message. Use {{language}} where the language should appear.')
		);

		const budgets = this.collapsibleSection(el, 'Token budgets (advanced)');
		budgets.createEl('p', {
			cls: 'mh-hint',
			text: 'Larger budgets cost more tokens and time. If a budget is too small, the model can run out of room and leave the text incomplete.',
		});
		this.numberRow(
			budgets,
			'Summary length limit',
			'Max tokens the model may use for the summary answer, before any reasoning headroom.',
			() => s.summaryMaxTokens,
			(v) => {
				s.summaryMaxTokens = v;
			},
			{ min: 256, step: 256, resetTo: DEFAULT_SUMMARY_MAX_TOKENS }
		);
		new Setting(budgets).setName('Reasoning headroom').setHeading();
		budgets.createEl('p', {
			cls: 'mh-hint',
			text: 'Extra tokens reserved for thinking at each effort level, added on top of the summary limit. Only used when reasoning is enabled.',
		});
		const budgetRow = (name: string, level: Exclude<ReasoningLevel, 'off'>) =>
			this.numberRow(
				budgets,
				name,
				'',
				() => s.reasoningBudgets[level],
				(v) => {
					s.reasoningBudgets[level] = v;
				},
				{ min: 0, step: 512, resetTo: DEFAULT_REASONING_BUDGETS[level] }
			);
		budgetRow('Low', 'low');
		budgetRow('Medium', 'medium');
		budgetRow('High', 'high');
		budgetRow('Extra high', 'xhigh');
		budgetRow('Max', 'max');
	}

	private buildCapture(el: HTMLElement): void {
		const s = this.plugin.settings;
		this.renderDevicePicker(
			new Setting(el)
				.setName('Input device')
				.setDesc(
					'Which microphone/input to record. To capture system audio on macOS, install a loopback ' +
						'device (e.g. BlackHole) and record from an aggregate device that includes it, then select it here.'
				),
			'inputDeviceId',
			'System default',
			'input'
		);
		this.renderDevicePicker(
			new Setting(el)
				.setName('System audio device')
				.setDesc(
					'Optional second input, recorded alongside the mic and mixed into one track. Pick a ' +
						'loopback device that carries system/meeting audio (e.g. BlackHole on macOS). ' +
						'Leave "Off" to record the microphone only.'
				),
			'systemAudioDeviceId',
			'Off',
			'system'
		);
		this.toggleRow(
			el,
			'Capture system audio',
			'Alternative to the device above: mix in system audio via a screen-share prompt. ' +
				'Works on some platforms but not reliably on macOS — if no system audio is captured ' +
				'you will be told, and recording continues with the microphone. On macOS, prefer the ' +
				'"System audio device" option above.',
			() => s.captureSystemAudio,
			(v) => {
				s.captureSystemAudio = v;
			}
		);
	}

	private buildOutput(el: HTMLElement): void {
		const s = this.plugin.settings;
		this.textRow(
			el,
			'Notes folder',
			'Where meeting notes are written.',
			() => s.notesFolder,
			(v) => {
				s.notesFolder = v.trim() || 'Scuttlebutt/Notes';
			},
			{ placeholder: 'Scuttlebutt/Notes', resetTo: DEFAULT_SETTINGS.notesFolder }
		);
		this.textRow(
			el,
			'Audio folder',
			'Where recordings are saved (when "Save audio" is on).',
			() => s.audioFolder,
			(v) => {
				s.audioFolder = v.trim() || 'Scuttlebutt/Audio';
			},
			{ placeholder: 'Scuttlebutt/Audio', resetTo: DEFAULT_SETTINGS.audioFolder }
		);
		this.renderFilenameTemplate(
			new Setting(el)
				.setName('Filename template')
				.setDesc('How new note filenames are built. Tokens: {{date}} (YYYY-MM-DD) and {{title}}.')
		);
		this.renderDateFormat(
			new Setting(el).setName('Date format').setDesc("Moment.js tokens for the note's date property.")
		);
		this.toggleRow(
			el,
			'Save audio into the vault',
			'Store the recording and embed a player in the note.',
			() => s.saveAudio,
			(v) => {
				s.saveAudio = v;
			}
		);
		this.toggleRow(
			el,
			'Include transcript in note',
			'Append the full transcript inside a collapsible callout.',
			() => s.includeTranscript,
			(v) => {
				s.includeTranscript = v;
			}
		);
		this.toggleRow(
			el,
			'Include memo in note',
			'Append your own notes inside a collapsible callout.',
			() => s.includeMemo,
			(v) => {
				s.includeMemo = v;
			}
		);
		this.toggleRow(
			el,
			'Auto-open note after saving',
			'',
			() => s.autoOpenNote,
			(v) => {
				s.autoOpenNote = v;
			}
		);
	}

	// ---- server group (shared by Transcription + Summary) ----------------

	private buildServer(el: HTMLElement, opts: EndpointOpts): void {
		new Setting(el).setName('Server').setHeading();
		this.renderEndpointUrl(new Setting(el).setName('Endpoint URL').setDesc('Base URL ending in /v1'), opts);
		this.renderApiKey(
			new Setting(el).setName('API key').setDesc('Leave empty if the server needs no auth.'),
			opts
		);
		this.renderModel(
			new Setting(el).setName('Model').setDesc('Populated after a successful test.'),
			opts
		);
		this.renderTimeout(
			new Setting(el)
				.setName('Request timeout')
				.setDesc(
					'Seconds to wait for the server before giving up. Set 0 to wait ' +
						'indefinitely — useful for long recordings on a slow or busy server.'
				),
			opts
		);
		this.renderTest(
			new Setting(el)
				.setName('Test connection')
				.setDesc('Validates the endpoint and loads its model list (10s timeout).'),
			opts
		);
	}

	// ---- render escape hatches ------------------------------------------

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
		// Keys are stored in Obsidian's secret storage via the plugin, not written to
		// settings/data.json directly. The masked field + reset behave exactly as before.
		const which = opts.apiKeyKey === 'sttApiKey' ? 'stt' : 'llm';
		let keyText!: TextComponent;
		setting
			.addText((t) => {
				keyText = t;
				t.inputEl.type = 'password';
				t.setPlaceholder('sk-…')
					.setValue(settings[opts.apiKeyKey])
					.onChange(async (v) => {
						this.plugin.setApiKey(which, v.trim());
						await this.plugin.saveSettings();
					});
			})
			.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Reset to default (clears the key)')
					.onClick(async () => {
						this.plugin.setApiKey(which, DEFAULT_SETTINGS[opts.apiKeyKey]);
						await this.plugin.saveSettings();
						keyText.setValue(settings[opts.apiKeyKey]);
					})
			);
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
		// Stack this row (name/desc above) so the editor spans the full width
		// instead of being squished into Obsidian's narrow control column.
		setting.settingEl.addClass('mh-prompt-setting');
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

	private renderFilenameTemplate(setting: Setting): void {
		const preview = setting.descEl.createDiv({ cls: 'mh-hint' });
		const refresh = () => {
			const tmpl = this.plugin.settings.filenameTemplate || DEFAULT_FILENAME_TEMPLATE;
			const name = sanitizeFileName(applyTemplate(tmpl, { date: todayStamp(new Date()), title: 'Meeting' }));
			preview.setText(`Preview: ${name}.md`);
		};
		let text!: TextComponent;
		setting
			.addText((t) => {
				text = t;
				t.setPlaceholder(DEFAULT_FILENAME_TEMPLATE)
					.setValue(this.plugin.settings.filenameTemplate)
					.onChange(async (v) => {
						this.plugin.settings.filenameTemplate = v;
						await this.plugin.saveSettings();
						refresh();
					});
			})
			.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Reset to default')
					.onClick(async () => {
						this.plugin.settings.filenameTemplate = DEFAULT_FILENAME_TEMPLATE;
						await this.plugin.saveSettings();
						text.setValue(this.plugin.settings.filenameTemplate);
						refresh();
					})
			);
		refresh();
	}

	private renderDateFormat(setting: Setting): void {
		const preview = setting.descEl.createDiv({ cls: 'mh-hint' });
		const refresh = () =>
			preview.setText('Preview: ' + mmt().format(this.plugin.settings.dateFormat || DEFAULT_DATE_FORMAT));
		let dateText!: TextComponent;
		setting
			.addText((t) => {
				dateText = t;
				t.setValue(this.plugin.settings.dateFormat).onChange(async (v) => {
					this.plugin.settings.dateFormat = v || DEFAULT_DATE_FORMAT;
					await this.plugin.saveSettings();
					refresh();
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Reset to default')
					.onClick(async () => {
						this.plugin.settings.dateFormat = DEFAULT_DATE_FORMAT;
						await this.plugin.saveSettings();
						dateText.setValue(this.plugin.settings.dateFormat);
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
