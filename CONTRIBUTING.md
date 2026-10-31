# Contributing to AtrisShare

AtrisShare is a foundation preview. Read the [roadmap](docs/ROADMAP.md) and
[architecture](docs/ARCHITECTURE.md) before taking on a feature. For substantial
changes, discuss the intended scope in the repository's issue tracker first.

## Development

Use Node.js 22 LTS and npm 10+, then run from the repository root:

```bash
npm ci
npm run check
```

Keep `package-lock.json` in source control. Do not commit build output, real
account data, source footage, OAuth credentials or machine-local planning notes.
`.env.example` must contain safe example values only.

## Pull requests

- Keep changes focused and document which milestone they advance.
- Keep `README.md` and `README.tr.md` aligned for user-facing setup/status changes.
- Distinguish working features, mocks and planned contracts in documentation.
- Include relevant type/build checks and meaningful tests for runtime behavior.
- Preserve explicit account/destination context and human publication approval.
- Include attribution/license notices for adapted or bundled third-party work.
- For UI changes, provide rendered evidence and cover key states/resizing.

Contributions are accepted under [Apache-2.0](LICENSE). Never include sensitive
security details in public issues; follow [SECURITY.md](SECURITY.md).
