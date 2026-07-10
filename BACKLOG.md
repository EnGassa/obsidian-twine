# Backlog

This file contains only active work. Completed items were pruned on 2026-07-10;
their implementation history and rationale remain available in Git.

## Working rules

- Use pnpm. Run `pnpm test`, `pnpm lint`, and `pnpm build` before considering
  an item complete.
- Preserve Twine's primary safety property: a conflict must never silently
  discard unique content.
- Treat bucket formats, encryption formats, and persisted manifests as public
  compatibility boundaries. Any change needs an explicit migration path.
- Add focused tests for every behavior change, plus randomized convergence
  coverage when sync semantics change.
- Keep automatic behavior conservative. When a merge cannot be proven safe,
  preserve both versions and let the user decide.

---

## 1. Make conflict preservation collision-proof

**Priority:** P0. Complete this before adding automatic merging.

**Problem:** Conflict copies are currently named from the source path, device
name, and a low-resolution timestamp. Two conflicts for the same path and
device can therefore select the same destination. `VaultAdapter.writeFile()`
updates an existing file, so a later conflict can overwrite an earlier
conflict copy and violate the no-silent-loss guarantee. The timestamp formatter
also produces an unintended `.0` suffix, and dotfiles produce awkward names.

The current canonical winner also compares a local filesystem mtime with the
remote object's server-side upload time. Those timestamps describe different
events and cannot reliably establish which edit is newer.

**Design:**

- Generate a readable base name containing the device and an ISO timestamp
  with millisecond precision.
- Include a stable short content-hash suffix so distinct losing versions do
  not map to the same path.
- Before writing, check whether the candidate path exists. If it contains the
  same content, reuse it; otherwise allocate a numeric suffix without
  overwriting anything.
- Handle dotfiles and extensionless files explicitly.
- Stop using incomparable clocks to choose a winner. Keep the existing remote
  canonical object at the original path and preserve the divergent local edit
  as the conflict copy. This is deterministic, minimizes remote mutations, and
  remains lossless. Automatic merging in item 2 can later replace both when it
  is demonstrably safe.
- Record enough provenance in logs to identify the original path, device, and
  hashes involved in the resolution. Do not put plaintext path metadata in the
  bucket.

**Acceptance:**

- Repeated conflicts for one path in the same millisecond preserve every
  distinct version.
- An existing unrelated conflict-copy path is never overwritten.
- Identical losing content does not create duplicate copies.
- Tests cover dotfiles, extensionless files, illegal device-name characters,
  identical timestamps, and deterministic behavior with skewed clocks.
- Randomized multi-device convergence remains green with a stronger assertion
  that every distinct non-deleted write survives somewhere.

---

## 2. Add conservative three-way merging for text files

**Priority:** P1. Depends on item 1.

**Problem:** Any divergent edits currently create a conflict copy, even when
the edits affect different lines and could be merged without ambiguity. The
manifest stores only the last-synced hash, so Twine does not currently retain
the common base content required for a correct three-way merge.

**Design:**

- Maintain a local base-content cache outside the visible vault for eligible
  text files after every successful sync. Do not put base plaintext in R2.
- Start with Markdown and plain-text files under a conservative size limit.
  Binary files and unsupported formats always use item 1's preservation path.
- Encrypt cached bases with the vault content key. Evict entries when their
  manifest paths are removed and bound total cache size.
- Use a maintained, mobile-compatible diff3 implementation rather than a
  hand-written merge algorithm.
- On divergence, merge `(base, local, remote)`. If the merge is clean, write
  the merged result locally and conditionally replace the observed remote
  object. If edits overlap, parsing fails, the base is missing, or the remote
  changes during the attempt, fall back to collision-proof conflict copies.
- Keep automatic merge behavior configurable and default it on only after the
  migration and mobile tests are proven reliable.

**Acceptance:**

- Non-overlapping Markdown edits merge into one canonical file with no
  conflict copy.
- Overlapping edits, missing/corrupt bases, unsupported files, and concurrent
  remote changes preserve both versions.
- Base-cache loss affects convenience only; it falls back safely and never
  blocks sync.
- Tests cover frontmatter, Unicode, line-ending differences, empty files,
  large-file limits, offline edits on three devices, and cache eviction.

---

## 3. Add a conflict review workflow

**Priority:** P2. Can begin after item 1; should understand item 2's outcomes.

**Problem:** Conflict copies are visible as ordinary files, but Twine provides
no consolidated view of what conflicted, which version became canonical, or
whether a copy has already been reviewed.

**Design:**

- Persist a small local conflict index containing path references, device,
  time, hashes, and resolution type (`preserved` or `auto-merged`). Do not store
  note content in the index.
- Add an Obsidian command that opens a compact conflict-review view.
- Allow opening the canonical file and preserved copy side by side, marking a
  conflict resolved, and deleting a reviewed copy only after confirmation.
- Treat the index as reconstructable metadata. Missing or corrupt index state
  must not delete files or interfere with sync.

**Acceptance:**

- Every newly preserved conflict appears in the review workflow.
- Review actions cannot delete the canonical note accidentally.
- Conflict state behaves predictably across restart, rename, and external
  deletion of a conflict copy.
- The workflow is usable on desktop and mobile without relying on a desktop
  status bar.
