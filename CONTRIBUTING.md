# Contributing

Twine is a personal-use project — it's maintained casually, not as a product with support commitments. That said, issues and PRs are welcome.

## Development

```
pnpm install
pnpm run build   # type-check + bundle main.js
pnpm test        # run the test suite
```

`pnpm run dev` runs esbuild in watch mode for local iteration.

## Before submitting a PR

- Run `pnpm run build` and `pnpm test` — both should pass cleanly.
- If you're changing sync/conflict logic, add a test to `test/sync-engine.test.ts` covering the scenario (see the existing tests there for the pattern: build a plan, run it against the in-memory mock adapters in `test/mock-adapters.ts`, assert on the resulting state).
- Keep `src/crypto/crypto.ts`'s PBKDF2 domain-separation labels untouched — changing them breaks decryption of anything already encrypted with the current scheme.

## Reporting a bug

Please include: what you were doing, what you expected, what happened instead, and (if it's a sync/conflict issue) whether it reproduces in the test suite's in-memory harness or only against a real bucket.
