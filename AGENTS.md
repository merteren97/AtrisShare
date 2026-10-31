# AtrisShare contributor/agent guidance

- This is a local-workspace preview. Distinguish working desktop/state from future publishing/media/AI contracts.
- Keep this repository standalone; never require sibling Atris repositories to build.
- Inspect `git status` before writes. Do not commit, push, release or deploy unless asked.
- Follow the current task and existing code conventions; keep changes scoped.
- If `.atris-local/` exists, read its `README.md` and follow its current phase handoff.
  It contains local planning only and must remain ignored. Public contributors can
  use `docs/ROADMAP.md` and `docs/ARCHITECTURE.md` without that directory.
- Every account operation needs explicit account and destination context. AI memory
  is not an authorization source. Never mix account contexts implicitly.
- Every live publication, including recurring occurrences, requires a human approval
  bound to the current destination, payload revision and artifact hashes.
- Keep provider credentials in the OS vault; never persist tokens in memory/prompts/logs.
- Manual and AI edits use the same non-destructive timeline; AI changes are proposals.
- Use official provider APIs and capability discovery. Report unsupported operations.
- Checks: `npm ci` then `npm run check`; runtime staging/lifecycle: `npm run test:runtime`.
  Native checks need Rust/Tauri prerequisites and `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.
  Never describe a planned or mocked flow as live. Keep `.atris-local/` verification data out of Git.
