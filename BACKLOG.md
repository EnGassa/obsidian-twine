# Backlog

**All 10 items below are done as of 2026-07-10.** 56 tests across 8 test
files (`pnpm test`), clean lint (`pnpm lint`), clean build (`pnpm build`).
Kept for the record of what changed and why — the "Fix"/"Migration" sections
document real constraints (bucket/manifest format compatibility, race
handling) worth knowing before touching this code again.

Improvements identified in a full-codebase review (2026-07-09), in priority order.
Each item is written to be independently executable. Read the referenced files
before starting; the inline comments in this codebase carry real constraints
(several encode lessons from live-testing bugs) — do not delete them.

General rules for working on any item:

- Package manager is **pnpm**. Run `pnpm test` (vitest) and `pnpm build`
  (tsc + esbuild) before considering an item done.
- Do not break the bucket format or manifest format casually. Items that
  change what's stored in the bucket (#2, #7) explicitly include a migration
  plan — follow it.
- Add/extend tests in `test/` for every behavior change. The sync engine is
  deliberately testable via the mock adapters in `test/mock-adapters.ts`.

---

## 1. Cache derived keys instead of re-deriving every sync pass — DONE

**Problem:** `runPass()` in `main.ts` calls `getKeys()` → `deriveKeys()`
(`src/crypto/crypto.ts`) on every pass. Each call runs PBKDF2 at 600k
iterations **twice** (content key + path HMAC key). With the 20-second
foreground interval in `src/triggers/triggers.ts` plus debounced file events,
that's ~1.2M PBKDF2 iterations every 20 seconds — significant CPU/battery
cost, worst on mobile.

**Fix:** Cache the `DerivedKeys` in memory on the plugin instance after first
derivation. Invalidate the cache when `settings.passphrase` or
`settings.saltBase64` changes (the settings tab in `src/settings.ts` writes
these; the cleanest hook is clearing the cache inside `saveSettings()` or
comparing the (passphrase, salt) pair the cache was derived from).

**Acceptance:** A pass with unchanged settings performs zero PBKDF2 work
after the first pass. Changing the passphrase in settings causes
re-derivation on the next pass. No key material is ever persisted to disk.

---

## 2. Replace plaintext SHA-256 content hash with a keyed HMAC — DONE

**Problem:** `S3RemoteAdapter.put()` (`src/store/s3-remote-adapter.ts`)
stores an **unkeyed SHA-256 of the plaintext** as unencrypted object metadata
(`x-amz-meta-content-hash`). Anyone with bucket read access (storage
provider, leaked token) can hash a known document and check whether it exists
in the vault — a confirmation-of-file attack that undercuts the E2E claim in
the README.

**Fix:** Use an HMAC keyed with a secret instead of bare SHA-256. Derive a
third key alongside the existing two in `deriveKeys()`
(`src/crypto/crypto.ts`) using the same pattern (purpose-labeled salt, e.g.
`"selfsync-contenthash-v1"`). Thread the keyed hash function through as the
sync engine's `hashFn` (see `SyncEngineContext` in
`src/sync/sync-engine.ts`) — local and remote hashes MUST use the same
function or every file will look changed.

**Migration (required, do not skip):** Existing buckets contain SHA-256
hashes. If the hash scheme just changes, every file's local hash stops
matching its remote metadata hash and the change detector will classify
everything as changed/conflicted. Plan:

- Version the metadata: write a new key `x-amz-meta-hash-v: 2` alongside the
  HMAC hash. Absence of the version marker means legacy SHA-256.
- On `list()`/`get()`, when an object is legacy: recompute nothing remotely —
  instead have the local side compute BOTH hashes for comparison purposes, or
  simpler: treat a legacy remote hash as matching if it equals the SHA-256 of
  the local content, and rewrite the object metadata to v2 on the next upload
  of that path (natural churn migrates the bucket over time).
- Also update the recovery key export/import (`exportRecoveryKey` /
  `importRecoveryKey` in `src/crypto/crypto.ts`) to carry the third key.
  This changes the recovery-key string format — make import accept both the
  old 2-part and new 3-part format.

**Acceptance:** New uploads carry no unkeyed plaintext hash. A vault synced
with the old format continues syncing with zero spurious conflicts. Tests
cover: fresh vault (v2 only), legacy bucket (mixed), and the recovery-key
format change.

---

## 3. Unicode-normalize vault paths before HMAC and manifest keying — DONE

**Problem:** Object keys are `HMAC(path)` (`hmacObjectKey` in
`src/crypto/crypto.ts`), but macOS/iOS report filenames in NFD while
Linux/Android/Windows typically use NFC. The same note `Café.md` produces
different HMACs on different devices → duplicate objects, phantom conflicts,
or files that never converge across a Mac↔Android pair.

**Fix:** Normalize every vault-relative path to NFC (`path.normalize("NFC")`)
at the boundary where paths enter the sync system — the safest single choke
point is `ObsidianVaultAdapter.listFiles()` (`src/obsidian-vault-adapter.ts`)
plus anywhere a path is HMAC'd or encrypted (`hmacObjectKey`, `encryptPath`).
Note: when *writing* a downloaded file locally, pass the NFC path to the
vault and let the OS store it however it wants; Obsidian handles that.
The manifest (`src/sync/manifest.ts`) must also key by normalized paths —
add a normalization step in `fromJSON` so existing manifests self-heal.

**Migration note:** A pre-existing bucket populated from a Mac may contain
objects keyed by HMAC(NFD path). After this change those decrypt fine via
their stored `enc-path` metadata but live at a "wrong" object key. The
change detector will see them as remote files whose path (now normalized
from metadata) doesn't match a locally-computed HMAC — verify via a test
that this resolves as a re-upload + delete of the stale object rather than
data loss. If it doesn't resolve cleanly, add explicit handling.

**Acceptance:** Test that NFD and NFC forms of the same path produce the
same object key and one manifest entry.

---

## 4. Detect wrong passphrase early with a key-check verifier — DONE

**Problem:** If a device is configured with the wrong passphrase against an
existing bucket, the failure surfaces as a cryptic WebCrypto
`OperationError` thrown from `decryptPath()` mid-`list()`. The user gets
"Twine failed: OperationError" with no hint it's the passphrase.

**Fix:** Extend `_sync-meta.json` (`src/store/sync-meta.ts`) with a key-check
verifier: alongside `saltBase64`, store e.g.
`keyCheck: base64(encryptBytes(contentKey, "twine-key-check-v1"))`, written
by whichever device creates the meta object. On startup of a sync pass (in
`getKeys()` / `ensureSalt()` in `main.ts`), after deriving keys, attempt to
decrypt the verifier; on failure, abort the pass with a clear Notice like
"Twine: passphrase doesn't match this bucket" and set the status bar to
error. Do NOT delete or overwrite anything on mismatch.

**Migration:** Existing buckets have `_sync-meta.json` without `keyCheck`.
If absent, write it (conditional `ifMatch` on the meta object's etag to
avoid a two-device race — on `PreconditionFailedError`, re-fetch and use
the winner's value). Never overwrite an existing keyCheck.

**Acceptance:** Wrong passphrase → immediate friendly error, no S3 object
mutations. Correct passphrase on legacy bucket → keyCheck gets added once.
Unit-test the verifier round-trip and the mismatch path.

---

## 5. Add a CI workflow that runs tests and typecheck — DONE

**Problem:** `.github/workflows/release.yml` builds on version bumps, but
nothing runs tests on push/PR. Releases are fully automated, so a regression
can ship untested.

**Fix:** Add `.github/workflows/ci.yml` triggered on `push` to main and on
`pull_request`: checkout, pnpm/action-setup@v4 (version 10),
actions/setup-node@v4 (node 20, cache pnpm), `pnpm install --frozen-lockfile`,
`pnpm test`, `pnpm build` (build already includes `tsc -noEmit`). Mirror the
setup steps from release.yml. Optionally also add the same
`pnpm test` step to release.yml before the build so a release can't ship
with failing tests.

**Acceptance:** Workflow green on a test push; a deliberately broken test
fails the workflow.

---

## 6. Eliminate the per-object HEAD request in `S3RemoteAdapter.list()` — DONE

**Problem:** `list()` (`src/store/s3-remote-adapter.ts`) issues one HEAD per
bucket object per pass to recover the `enc-path`/`content-hash` metadata,
because ListObjectsV2 doesn't return custom metadata. A 500-file vault =
500 HEADs every 20 seconds. The file's own comment already flags this.

**Fix:** Cache the metadata by ETag. Persist a map
`objectKey → { etag, path, contentHash }` (in plugin data via a new
persisted structure — NOT in the sync manifest, which is keyed by path and
has different semantics). On each `list()`: for objects whose listed ETag
matches the cache, use cached values and skip the HEAD; otherwise HEAD,
decrypt, and update the cache. Evict cache entries for object keys no longer
present in the listing. The cache is a pure performance layer — corruption
or loss of it must only cause extra HEADs, never wrong sync decisions.

**Acceptance:** Steady-state pass over an unchanged bucket performs exactly
one LIST call (per 1000 objects) and zero HEADs. Changed/new objects still
get HEAD'd exactly once. Add a test using a counting fake fetcher or a
counting adapter.

---

## 7. Bind ciphertext to its path with AES-GCM AAD — DONE

**Problem:** `encryptBytes()` (`src/crypto/crypto.ts`) uses no additional
authenticated data, so an attacker with bucket **write** access can copy the
ciphertext from object A to object key B; the plugin will decrypt it
successfully and write file A's content at file B's path.

**Fix:** Pass the vault-relative path (post-NFC-normalization, see item 3)
as AES-GCM `additionalData` when encrypting/decrypting file content in
`S3RemoteAdapter`. Version the blob format so old blobs still decrypt:
prefix new blobs with a 1-byte version (e.g. `0x02`), keep the current
`nonce || ciphertext` parse as the fallback when the first byte isn't a
known version marker — note the current format starts with a random nonce
byte, so pick the version byte scheme carefully (e.g. new format =
`0x02 || nonce || ciphertext`, and try v2-with-AAD first, fall back to
legacy-no-AAD parse on failure). Rewrite to v2 on natural re-upload.

**Depends on:** do item 3 first (path normalization changes the AAD value).

**Acceptance:** Round-trip test with AAD; test that legacy blobs (no
version byte, no AAD) still decrypt; test that a ciphertext moved to a
different path fails decryption for v2 blobs.

---

## 8. Record the real post-write mtime after downloads — DONE

**Problem:** `applyDownloadRemote` and `applyConflict`
(`src/sync/sync-engine.ts`) write the manifest entry with
`mtime: Date.now()`, but the vault assigns its own mtime when the file is
written. On the next pass the cheap mtime/size check in
`computeLocalStates()` misses, so every downloaded file is fully re-read and
re-hashed once. Compounds with item 6 on mobile.

**Fix:** After `ctx.vault.writeFile(...)`, stat the file and record its
actual mtime. Add a `stat(path)` method to the `VaultAdapter` interface
(`src/sync/adapters.ts`), implement it in `ObsidianVaultAdapter`
(via `getAbstractFileByPath(path).stat`) and in the test mock
(`test/mock-adapters.ts`).

**Acceptance:** Test: after a download pass, the immediately following pass
performs zero `readFile` calls for the downloaded path (counting mock).

---

## 9. Wire up recovery-key import (or stop advertising recovery) — DONE

**Problem:** `importRecoveryKey()` exists in `src/crypto/crypto.ts` but
nothing calls it. Settings (`src/settings.ts`) only exports. The README
tells users the exported recovery key is "the only way to recover your data
if you forget your passphrase" — but the plugin has no way to actually use
it. As shipped, recovery is impossible.

**Fix:** Add an "Import recovery key" flow in the settings tab: user pastes
the exported string, plugin validates it via `importRecoveryKey()`, and
sync runs off imported keys instead of passphrase-derived ones. This
requires the key-acquisition path in `main.ts` (`getKeys()`) to support two
modes: derive-from-passphrase or use-imported-keys (persist the imported
key material in settings — document in the settings UI that this stores key
material on disk, same trust level as the passphrase already stored there).
Coordinate with item 2 if done after it (3-part key format).

**Acceptance:** With a correct recovery key and NO passphrase set, a device
can fully sync an existing bucket. Malformed keys produce a clear error.

---

## 10. Housekeeping (small, independent) — DONE

- **Stop committing `main.js`.** Releases carry the built artifact and the
  provenance attestation exists precisely so users don't trust a committed
  bundle. Remove it from the repo, add to `.gitignore`. Update the README
  manual-install section if it references the in-repo file (it currently
  points at releases, which is correct).
  — Already gitignored/untracked; nothing to do.
- **Remove or gitignore `discord-post-draft.md` and `forum-post-draft.md`**
  (untracked drafts at the repo root; they don't belong in the published
  repo).
  — Added to `.gitignore`.
- **Add ESLint** using the Obsidian sample-plugin config as the baseline
  (the community-store review tooling assumes it). Add a `pnpm lint` script
  and run it in the CI workflow from item 5.
  — Added flat config (`eslint.config.mjs`) + `pnpm lint`, wired into CI.
