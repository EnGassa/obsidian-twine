# Mobile lifecycle spike (Phase 0, Spike 1)

Throwaway plugin — answers two questions before we build sync logic on top of assumptions:
1. Does WebCrypto (AES-GCM, PBKDF2, HMAC-SHA256) actually work in Obsidian's mobile WebView?
2. What really happens to a plugin's JS when the app is backgrounded, resumed, or killed on your phone — is "resume" a fresh `onload`, or does state survive?

## Install (sideload — this never goes through the plugin store)

1. Copy this folder to `<YourVault>/.obsidian/plugins/selfsync-mobile-spike/` on your **test vault** (use a throwaway vault, not your real one).
   - Easiest path: put the folder somewhere Syncthing/iCloud/AirDrop/USB can reach the device, then move it into place using the Files app (iOS) or a file manager (Android) — or if the vault is already reachable via the Obsidian mobile Files integration, copy directly.
2. In Obsidian mobile: Settings → Community plugins → turn on Community plugins (if off) → Installed plugins → find "SelfSync Mobile Spike (throwaway)" → enable it.
3. You should see a Notice pop up immediately reporting whether the WebCrypto self-test passed.

## What to actually do once it's running

1. Note the WebCrypto test result (Notice + `_mobile-spike-log.md` in the vault).
2. Background the app (press home / switch away) for a few seconds, then reopen it. Check the log.
3. Background it for a much longer time (several minutes, or force it out of the app switcher / force-quit it on iOS), then reopen. Check the log again.
4. Compare: after a short background, do you see `window blur` → `window focus` with no new `onload`? After a long background or force-quit, do you see a brand new `onload` (i.e. the plugin fully reloaded)?

## What we're looking for

- **WebCrypto self-test PASS** confirms the crypto module design (AES-256-GCM + PBKDF2 + HMAC via `crypto.subtle`, no libsodium/WASM) actually works on this device — this is the thing the real plugin's `src/crypto/crypto.ts` depends on entirely.
- **Lifecycle behavior** tells us whether the real plugin's "full manifest rescan on every foreground resume" design (see the plan) is necessary-but-sufficient, or whether there's a window where state looks alive but is actually stale in a way that needs more defensive handling. If a long background always produces a fresh `onload`, that's the easy case — full rescan on load already covers it, no extra defensive code needed. If you instead see `focus` fire with no new `onload` after a long background, that's the harder case worth designing around explicitly.

## Cleanup

Delete `.obsidian/plugins/selfsync-mobile-spike/` from the test vault when done. This plugin has no purpose beyond this one investigation.
