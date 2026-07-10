# Three-Way Text Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Automatically merge non-overlapping edits to small Markdown/text files while preserving the existing lossless conflict-copy fallback.

**Architecture:** Add a pure diff3 wrapper for line arrays, an encrypted local base-content cache with bounded size, and an optional base-cache service on `SyncEngineContext`. The sync engine attempts a merge only when a valid base exists and both sides are eligible text; every ambiguity, unsupported file, cache miss, or conditional-write race uses the existing collision-proof conflict path.

**Tech Stack:** TypeScript, `diff3@0.0.4`, WebCrypto AES-GCM, Obsidian plugin data, Vitest.

---

### Task 1: Add and test the pure three-way merge primitive

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/sync/text-merge.ts`
- Create: `test/text-merge.test.ts`

- [ ] **Step 1: Add the dependency and write failing merge tests**

Add `diff3` as a runtime dependency. Create tests for: non-overlapping local/remote line edits producing one merged string; identical edits producing one merged string; overlapping edits returning `conflict`; empty base/local/remote values; LF/CRLF normalization; and malformed/unsupported input returning `conflict` rather than throwing.

- [ ] **Step 2: Run the focused tests and verify the intended RED state**

Run `pnpm vitest run test/text-merge.test.ts`. Expected: the test file fails because `src/sync/text-merge.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal wrapper**

Export `mergeText(base, local, remote): { status: "merged"; text: string } | { status: "conflict" }`. Normalize `\\r\\n` and bare `\\r` to `\\n`, split into lines while preserving whether the input ended with a newline, call `diff3` with `(localLines, baseLines, remoteLines)`, return `conflict` if any result segment has a `conflict` field, and join clean `ok` segments. Do not attempt syntax-aware Markdown merging.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run `pnpm vitest run test/text-merge.test.ts`. Expected: all merge tests pass.

### Task 2: Add an encrypted bounded base-content cache

**Files:**
- Create: `src/sync/base-cache.ts`
- Create: `test/base-cache.test.ts`

- [ ] **Step 1: Write failing cache tests**

Test round-trip storage and retrieval for an eligible text path, rejection of binary/oversized entries, eviction when the total byte budget is exceeded, deletion by path, malformed serialized data being ignored, and decryption failure clearing only the affected entry.

- [ ] **Step 2: Run the focused tests and verify RED**

Run `pnpm vitest run test/base-cache.test.ts`. Expected: the test file fails because the cache module does not exist.

- [ ] **Step 3: Implement the cache**

Define `BaseContentCache` with `get(path)`, `set(path, bytes)`, `delete(path)`, and `toJSON()`. Store only `.md`, `.markdown`, `.mdx`, and `.txt` files no larger than 128 KiB each, cap aggregate ciphertext at 512 KiB, encrypt bytes with `encryptContentBlob(contentKey, bytes, normalizedPath)`, base64 encode ciphertext, and evict least-recently-used entries until under budget. Treat corrupt records or authentication failures as cache misses and remove only those records. Persist metadata needed for LRU ordering, but never plaintext.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run `pnpm vitest run test/base-cache.test.ts`. Expected: all cache tests pass.

### Task 3: Integrate merge and base snapshots into sync

**Files:**
- Modify: `src/sync/adapters.ts`
- Modify: `src/sync/sync-engine.ts`
- Modify: `test/sync-engine.test.ts`
- Modify: `test/randomized-convergence.test.ts`

- [ ] **Step 1: Write failing engine tests**

Add tests proving that two non-overlapping edits against a known base produce one merged canonical file and no conflict copy; overlapping edits preserve both versions; missing base falls back to one collision-proof copy; binary files never merge; and a remote conditional-write race falls back without losing either edit. Add a test that successful upload/download/merge operations refresh the base cache with the canonical bytes.

- [ ] **Step 2: Run the focused engine tests and verify RED**

Run `pnpm vitest run test/sync-engine.test.ts`. Expected: the new merge tests fail because the context has no base cache and conflicts always use preservation.

- [ ] **Step 3: Extend the engine context and implement conservative integration**

Add optional `baseCache?: BaseContentCache` to `SyncEngineContext`. After successful upload, download, and clean merge, cache the canonical bytes; delete entries when a path is deleted. In `applyConflict()`, read the base and both current byte arrays, call `mergeText()` only when the cache returns a valid eligible text base and both current files remain eligible, and on a clean merge conditionally `remote.put()` the merged bytes with the observed ETag, write them locally, stat the result, hash the merged bytes with `ctx.hashFn`, update the manifest, and cache the merged bytes. On any conflict result, cache miss, unsupported file, decode failure, or `PreconditionFailedError`, use the existing collision-proof preservation path unchanged.

- [ ] **Step 4: Run focused engine and randomized tests**

Run `pnpm vitest run test/text-merge.test.ts test/base-cache.test.ts test/sync-engine.test.ts test/randomized-convergence.test.ts`. Expected: all pass with no convergence regressions.

### Task 4: Wire encrypted cache persistence into the plugin

**Files:**
- Modify: `main.ts`
- Modify: `test/recovery-key-sync.test.ts`
- Modify: `BACKLOG.md`

- [ ] **Step 1: Write failing persistence tests**

Add a plugin-level serialization test around the cache record shape, or extend the existing recovery/sync integration harness to assert that a cache survives serialization and is decryptable after reload with the same derived content key. Assert a changed key yields cache misses rather than plaintext leakage or sync failure.

- [ ] **Step 2: Run the focused test and verify RED**

Run `pnpm vitest run test/recovery-key-sync.test.ts`. Expected: the new persistence assertion fails because `PluginData` does not contain base-cache state.

- [ ] **Step 3: Wire cache lifecycle**

Add a serialized base-cache field to `PluginData`, load it with settings/manifest, construct the cache after `getKeys()` derives or imports keys, pass it into `runSyncPass()`, include its JSON in `persist()`, and clear/replace it when the key source changes. Preserve the existing recovery-key behavior and never upload cache records to R2.

- [ ] **Step 4: Update the backlog and run the full suite**

Mark item 2 complete only after `pnpm test`, `pnpm lint`, and `pnpm build` pass. Keep item 3 active. Add a short implementation note describing the supported extensions, size limits, encrypted local storage, and fallback behavior.

- [ ] **Step 5: Commit the implementation slice**

```bash
git add package.json pnpm-lock.yaml src/sync/text-merge.ts src/sync/base-cache.ts src/sync/adapters.ts src/sync/sync-engine.ts main.ts test/text-merge.test.ts test/base-cache.test.ts test/sync-engine.test.ts test/randomized-convergence.test.ts test/recovery-key-sync.test.ts BACKLOG.md docs/superpowers/plans/2026-07-10-three-way-text-merge.md
git commit -m "feat: merge non-overlapping text conflicts"
```
