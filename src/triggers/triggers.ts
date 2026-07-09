import { App, Plugin } from "obsidian";
import { SyncQueue } from "../sync/queue";

const FOREGROUND_INTERVAL_MS_DEFAULT = 90_000;

/**
 * Wires every event that should trigger a sync pass to one SyncQueue. Mobile
 * has no true background execution — iOS/Android suspend or kill the WebView
 * once backgrounded — so every one of these fires only while the app is
 * actually open/foregrounded. That's an accepted platform limit, not a bug
 * (see plan "Known Risks" #2): the interval timer and vault-event listeners
 * simply stop firing while backgrounded and resume (or restart fresh, on iOS)
 * the next time the app is foregrounded.
 */
export function registerSyncTriggers(
	plugin: Plugin,
	app: App,
	queue: SyncQueue,
	intervalMs: number = FOREGROUND_INTERVAL_MS_DEFAULT
): void {
	// On app open / layout ready: full pass, including a manifest rescan to
	// catch any drift from a mobile app that was suspended (not just closed).
	app.workspace.onLayoutReady(() => queue.schedule());

	// On vault file changes, debounced inside SyncQueue so rapid edits coalesce.
	plugin.registerEvent(app.vault.on("create", () => queue.schedule()));
	plugin.registerEvent(app.vault.on("modify", () => queue.schedule()));
	plugin.registerEvent(app.vault.on("delete", () => queue.schedule()));
	plugin.registerEvent(app.vault.on("rename", () => queue.schedule()));

	// Foreground-only interval timer; cleared automatically via registerInterval
	// on plugin unload (covers app close/reload, not backgrounding — JS execution
	// halts while backgrounded on mobile regardless, so no extra cleanup needed there).
	plugin.registerInterval(window.setInterval(() => queue.schedule(), intervalMs));

	// App resume from background: on desktop this fires while the process is
	// still alive; on iOS the app is commonly fully suspended/killed instead, in
	// which case "resume" is really just a fresh onLayoutReady above. Either way
	// a fresh sync pass runs, and computeLocalStates() always does a full
	// manifest-vs-vault rescan rather than trusting cached event deltas.
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") queue.schedule();
	});
}
