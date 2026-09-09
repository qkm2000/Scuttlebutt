import { App, FuzzySuggestModal, Modal, TFile } from 'obsidian';

export class ConfirmModal extends Modal {
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

export class SaveChoiceModal extends Modal {
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

export class FileSuggestModal extends FuzzySuggestModal<TFile> {
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
