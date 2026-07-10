# Conflict Preservation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make conflict preservation collision-proof and deterministic without changing Twine's bucket format.

**Architecture:** Keep the remote version canonical when both local and remote have diverged, and preserve the local version as a uniquely allocated local conflict copy. Move conflict-copy allocation into the sync engine, where vault existence and content can be checked, while keeping pure naming helpers in `src/sync/conflict.ts`.

**Tech Stack:** TypeScript, Obsidian VaultAdapter, Vitest mock adapters, pnpm.

---

### Task 1: Define safe conflict names and remote-canonical resolution

**Files:**
- Modify: `src/sync/conflict.ts`
- Test: `test/conflict.test.ts`

- [ ] **Step 1: Write failing tests for name formatting and winner policy**

Add tests that assert a millisecond timestamp is preserved without the current `.0` artifact, dotfiles retain their filename stem, and divergent entries always resolve to `remote` regardless of local mtime. Keep the existing illegal-device-name test and update only its expected name to the new format.

- [ ] **Step 2: Run the focused tests and verify they fail for the intended reasons**

Run `pnpm vitest run test/conflict.test.ts`. Expected: the new timestamp, dotfile, and winner assertions fail while unrelated validation tests continue to pass.

- [ ] **Step 3: Implement the minimal pure helpers**

Change `resolveConflict()` to return `winner: "remote"`. Replace timestamp construction with `when.toISOString().replace("T", " ").replace(/:/g, "").replace(/Z$/, "")` and make extension detection treat a leading-dot basename as extensionless. Include the losing local content-hash prefix in the generated name so distinct versions get distinct base candidates.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run `pnpm vitest run test/conflict.test.ts`. Expected: all conflict unit tests pass.

### Task 2: Add collision-proof copy allocation in the sync engine

**Files:**
- Modify: `src/sync/sync-engine.ts`
- Test: `test/sync-engine.test.ts`

- [ ] **Step 1: Write a failing integration test for repeated conflict copies**

Add a test that runs two conflict resolutions for the same `note.md`, same device, and same timestamp with different losing contents. Assert that both generated paths exist and that neither original content is overwritten. Add a second assertion that repeating the same losing content reuses the existing copy instead of creating a duplicate.

- [ ] **Step 2: Run the focused integration test and verify it fails**

Run `pnpm vitest run test/sync-engine.test.ts`. Expected: the new test fails because `applyConflict()` currently writes one fixed path and has no allocation step.

- [ ] **Step 3: Add the smallest allocation helper using existing vault APIs**

Use the existing `VaultAdapter.listFiles()` and `readFile()` methods; do not change the adapter interfaces or add bucket metadata. Build an in-memory path set once per conflict allocation and read only occupied candidate paths when comparing content.

- [ ] **Step 4: Implement deterministic candidate allocation**

In `sync-engine.ts`, derive the losing content hash from the already-read bytes, create the base name using the conflict helper, and probe the vault before writing. If a candidate exists, compare bytes and reuse it when identical; otherwise append ` 2`, ` 3`, and so on until an unused path is found. Pass the allocated path to `writeFile()` and leave it untracked so the existing next-pass upload behavior remains intact.

- [ ] **Step 5: Run the focused test and verify it passes**

Run `pnpm vitest run test/sync-engine.test.ts test/conflict.test.ts`. Expected: all focused tests pass, including both local-winner tests updated to the new remote-canonical behavior.

### Task 3: Strengthen convergence and regression coverage

**Files:**
- Modify: `test/randomized-convergence.test.ts`
- Modify: `test/conflict.test.ts`
- Modify: `BACKLOG.md`

- [ ] **Step 1: Add assertions for conflict-copy uniqueness and content survival**

Extend the randomized preservation scenario to assert that every distinct non-deleted write is present in at least one final vault path, including conflict copies, unless that path was explicitly deleted after the write. Add a deterministic same-timestamp regression test to `test/conflict.test.ts`.

- [ ] **Step 2: Run the full verification suite**

Run `pnpm test`, `pnpm lint`, and `pnpm build`. Expected: all tests pass, ESLint reports no errors, and TypeScript/esbuild exits successfully.

- [ ] **Step 3: Mark only item 1 complete**

Update `BACKLOG.md` so item 1 records the implemented behavior and tests, while items 2 and 3 remain active. Do not mark automatic merging or review UX complete.

- [ ] **Step 4: Commit the implementation slice**

Run:

```bash
git add src/sync/conflict.ts src/sync/sync-engine.ts src/sync/adapters.ts src/obsidian-vault-adapter.ts test/conflict.test.ts test/sync-engine.test.ts test/randomized-convergence.test.ts BACKLOG.md
git commit -m "fix: harden conflict copy preservation"
```
