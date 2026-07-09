# 🧵 Twine

A personal, end-to-end encrypted Obsidian vault sync plugin — no server to run, no subscription.

Twine syncs your vault directly to a bucket you own (Cloudflare R2, Backblaze B2, or anything S3-compatible). There's no custom backend: the plugin talks straight to your bucket, encrypting everything client-side before it ever leaves your device. It exists as a personal alternative to Obsidian Sync's $4–8/mo subscription and to self-hosted CouchDB-based sync tools, which trade that subscription for a server you have to keep running and patched.

## Why

- **Obsidian Sync** costs money, indefinitely.
- **Self-hosted LiveSync** (CouchDB) is free, but you're now running and maintaining a server.
- **Twine**: your plugin talks directly to a cheap/free object storage bucket you already control. No server, no subscription — just cloud storage costs, which for a typical vault are effectively $0–1/month.

## How it works

- **No custom backend.** All sync, conflict resolution, and versioning logic lives in the plugin itself. It talks to your bucket over the S3 API.
- **End-to-end encrypted.** File contents, paths, and folder structure are encrypted client-side (AES-256-GCM, key derived via PBKDF2 from your passphrase) before upload. The bucket only ever sees ciphertext and opaque object keys — not even Cloudflare/Backblaze can read your notes.
- **Safe conflicts.** If two devices edit the same file before syncing, both versions survive — one stays at the canonical path, the other is saved alongside it as a `(conflicted copy ...)` file. Nothing is ever silently overwritten.
- **Responsive.** Syncs on file changes (debounced), on a foreground timer, and instantly on app open/resume — without needing a server to push changes to you.

## Setup

### 1. Create a bucket

Any S3-compatible object storage works. Cloudflare R2 is recommended — it has a generous free tier and zero egress fees.

1. Create an R2 bucket in the Cloudflare dashboard.
2. Create an R2 API token scoped to that bucket (gives you an Access Key ID + Secret Access Key).
3. Note your account's R2 endpoint: `https://<accountid>.r2.cloudflarestorage.com`.

### 2. Install the plugin

Twine is in Obsidian's Community Plugin directory — [community.obsidian.md/plugins/twine](https://community.obsidian.md/plugins/twine).

1. In Obsidian: Settings → Community plugins → Browse → search for "Twine" → Install → Enable.
2. Repeat on every device you want synced, including mobile (the Community Plugins browser works the same way on Android/iOS).

Updates from here on show up as a normal "Update available" in the Community Plugins tab — no manual rebuilding or file copying needed.

**Manual install** (only needed for a pre-release build, or if a new release hasn't propagated into the directory's search index yet — that can take up to 24 hours after publishing):

1. Download `main.js` and `manifest.json` from the [latest release](../../releases/latest).
2. Copy both files into `<YourVault>/.obsidian/plugins/twine/` (create the folder if needed).
3. In Obsidian: Settings → Community plugins → make sure Community plugins are enabled → find "Twine" and turn it on.

### 3. Configure

Open Settings → Twine and fill in:

- **Endpoint** — your bucket's S3 endpoint. You can paste Cloudflare's full bucket URL (with the bucket name in the path) directly here; it auto-splits into Endpoint + Bucket for you.
- **Region** — `auto` for R2.
- **Bucket**, **Access key ID**, **Secret access key** — from step 1.
- **Device name** — used to label conflict-copy files (e.g. "laptop", "phone").
- **Passphrase** — the encryption passphrase. **Use the same passphrase on every device.** The PBKDF2 salt itself is shared automatically via the bucket, so you only need to remember one passphrase across all your devices.

Click **Test connection** to confirm the endpoint/bucket/keys actually work before relying on them.

### 4. Back up your recovery key

Click **Export recovery key** and save the output somewhere safe (a password manager, printed copy). This is the only way to recover your data if you ever forget your passphrase — there is no server-side recovery, by design.

## Mobile install

Twine being in the Community Plugin directory means mobile install works the same as desktop: Settings → Community plugins → Browse → search "Twine" → Install.

If you need to sideload instead (a pre-release build, or a fresh release that hasn't propagated to the directory's search index yet):

- **Android**: connect via USB with `adb` (`brew install android-platform-tools` on macOS), enable Developer Options + USB debugging on the phone, then `adb push manifest.json main.js /storage/emulated/0/<path-to-vault>/.obsidian/plugins/twine/`.
- **iOS**: copy the files into the vault folder via the Files app, iCloud Drive, or another file-sync method you already use to get the vault onto the device.

## Known limitations

- **Personal-use scope.** No billing, no multi-tenant support — it's a free tool for syncing your own vault to your own storage, not a product.
- **No in-app version history browser yet.** Enable bucket versioning (e.g. R2 object versioning) at the storage-provider level as a safety net; a plugin-side history UI is a possible future addition.
- **Mobile has no true background sync.** iOS/Android suspend or kill the app's JS when backgrounded — sync happens while the app is open/foregrounded (on open, on resume, on a timer, or via the manual "Sync now" command).
- **Whole-file transfer only** — no delta/chunked sync. Fine at personal vault scale; not optimized for very large binary attachments.

## License

MIT — see [LICENSE](LICENSE).
