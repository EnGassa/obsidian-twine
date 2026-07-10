import { vi } from "vitest";

export class Plugin {
	loadData = vi.fn();
	saveData = vi.fn();
	addSettingTab = vi.fn();
	addStatusBarItem = vi.fn(() => ({ setText: vi.fn() }));
	addRibbonIcon = vi.fn();
	addCommand = vi.fn();
}

export class Notice {}

export const Platform = {
	isMobile: false,
};

export class PluginSettingTab {
	constructor(public app: unknown, public plugin: unknown) {}
	display() {}
}

export class Setting {
	constructor(public containerEl: unknown) {}
	setName = vi.fn().mockReturnThis();
	setDesc = vi.fn().mockReturnThis();
	addText = vi.fn().mockReturnThis();
	addToggle = vi.fn().mockReturnThis();
	addButton = vi.fn().mockReturnThis();
}

export class App {}
export class Vault {}
export class TFile {}

export const requestUrl = vi.fn();
