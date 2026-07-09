/*
THROWAWAY DIAGNOSTIC PLUGIN — not part of the real Self Sync plugin.
Purpose: answer Phase 0 Spike 1 from the plan — how does Obsidian mobile
actually behave when backgrounded/resumed/killed, and does WebCrypto
(AES-GCM, PBKDF2, HMAC-SHA256) work in the mobile WebView sandbox.
Delete this plugin folder once you've captured what you need.

Hand-written plain CJS (no build step) so it can be sideloaded directly.
*/

const { Plugin, Notice } = require("obsidian");

const LOG_PATH = "_mobile-spike-log.md";

async function logEvent(app, message) {
	const line = `${new Date().toISOString()} — ${message}\n`;
	try {
		const file = app.vault.getAbstractFileByPath(LOG_PATH);
		if (file) {
			await app.vault.append(file, line);
		} else {
			await app.vault.create(LOG_PATH, line);
		}
	} catch (e) {
		console.error("[selfsync-spike] log write failed", e);
	}
}

async function webCryptoSelfTest() {
	const enc = new TextEncoder();

	const passphraseKey = await crypto.subtle.importKey(
		"raw",
		enc.encode("test-passphrase"),
		"PBKDF2",
		false,
		["deriveKey"]
	);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const aesKey = await crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
		passphraseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"]
	);

	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = enc.encode("hello self-sync spike");
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext);
	const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext);
	const roundtrip = new TextDecoder().decode(decrypted);

	const hmacKey = await crypto.subtle.importKey(
		"raw",
		enc.encode("hmac-test-key-000000000000000000"),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const sig = await crypto.subtle.sign("HMAC", hmacKey, enc.encode("path/to/note.md"));

	return {
		ok: roundtrip === "hello self-sync spike" && sig.byteLength === 32,
		roundtrip,
	};
}

module.exports = class MobileSpikePlugin extends Plugin {
	async onload() {
		await logEvent(this.app, "onload fired");

		this.app.workspace.onLayoutReady(async () => {
			await logEvent(this.app, "onLayoutReady fired");
		});

		this._onVisibilityChange = () => {
			void logEvent(this.app, `visibilitychange -> ${document.visibilityState}`);
		};
		document.addEventListener("visibilitychange", this._onVisibilityChange);

		this._onFocus = () => void logEvent(this.app, "window focus");
		this._onBlur = () => void logEvent(this.app, "window blur");
		window.addEventListener("focus", this._onFocus);
		window.addEventListener("blur", this._onBlur);

		try {
			const result = await webCryptoSelfTest();
			await logEvent(
				this.app,
				`WebCrypto self-test: ${result.ok ? "PASS" : "FAIL"} (roundtrip="${result.roundtrip}")`
			);
			new Notice(`SelfSync spike: WebCrypto ${result.ok ? "OK" : "FAILED"} — see ${LOG_PATH}`);
		} catch (e) {
			await logEvent(this.app, `WebCrypto self-test THREW: ${e}`);
			new Notice("SelfSync spike: WebCrypto threw an error — see " + LOG_PATH + " and console");
		}

		new Notice("SelfSync mobile spike loaded. Now background/reopen/kill-and-reopen the app, then check " + LOG_PATH);
	}

	async onunload() {
		document.removeEventListener("visibilitychange", this._onVisibilityChange);
		window.removeEventListener("focus", this._onFocus);
		window.removeEventListener("blur", this._onBlur);
		await logEvent(this.app, "onunload fired");
	}
};
