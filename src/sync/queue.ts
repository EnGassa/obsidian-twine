/**
 * Debounces/coalesces rapid vault events (e.g. autosave firing on every
 * keystroke pause) into a single sync pass, so we don't hammer the network
 * with a request per file per edit.
 */
export class SyncQueue {
	// window.setTimeout always returns a number in a browser/Electron/Obsidian
	// renderer context (unlike Node's global setTimeout, which @types/node's
	// ambient declarations otherwise pull in here as NodeJS.Timeout).
	private timer: number | undefined;
	private pending = false;
	private running = false;

	constructor(
		private readonly debounceMs: number,
		private readonly runSyncPass: () => Promise<void>
	) {}

	/** Call on any event that should eventually trigger a sync pass. */
	schedule(): void {
		if (this.timer !== undefined) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.trigger(), this.debounceMs);
	}

	/** Runs a sync pass immediately (e.g. manual "Sync now" command). */
	async triggerNow(): Promise<void> {
		if (this.timer !== undefined) {
			window.clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.trigger();
	}

	private async trigger(): Promise<void> {
		this.timer = undefined;

		if (this.running) {
			// A pass is already in flight; remember to run again right after,
			// so edits that land mid-pass aren't lost until the next debounce.
			this.pending = true;
			return;
		}

		this.running = true;
		try {
			await this.runSyncPass();
		} finally {
			this.running = false;
			if (this.pending) {
				this.pending = false;
				this.schedule();
			}
		}
	}

	dispose(): void {
		if (this.timer !== undefined) window.clearTimeout(this.timer);
	}
}
