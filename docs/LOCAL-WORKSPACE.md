# Local workspace — Phase 1 and YouTube connection slice

## What works

- React/Vite UI in browser development and a Tauri 2 native shell.
- Explicit demo target identities for YouTube, X, TikTok and LinkedIn. These are
  local records, not connected social accounts, OAuth sessions or publishable targets.
- Project creation/opening, persistent account/project selection, separate
  account-wide and project memory scopes.
- Memory creation, inspection, editing and deletion; categories, source/time,
  suggested/confirmed state, immutable provenance and optimistic revision checks.
- Search/category/state filters, current-scope audit, loading/error/retry states,
  Turkish/English UI and persistent dark/light appearance preferences.
- SQLite migration/repository layer and an internal Windows DPAPI credential port.
- YouTube OAuth/PKCE, channel/subject checks, vault storage, refresh and disconnect;
  see [setup and live-acceptance limitations](YOUTUBE.md).

## Development commands

Use Node.js 22 LTS, npm 10+ and `npm ci`. The workspace pins Node **22.23.2** as a
development dependency, so npm scripts use the same executable that is staged for
the desktop. Node's built-in SQLite is experimental in this release; its database
files are ordinary SQLite files, but the application API may require adaptation
when upgrading Node.

```bash
npm run dev             # Vite + authenticated local API, 127.0.0.1:1438
npm run tauri:dev       # Native shell; Rust owns the API, Vite serves UI only
npm run check           # Type checks, storage/API/OAuth tests, frontend/core build
npm run test:runtime    # Stage and exercise the isolated packaged Node/API
npm run preview         # Feature manifest only
```

Native development also requires the platform's Tauri 2 prerequisites. On Windows:
Rust stable, Microsoft C++ Build Tools and WebView2.

```bash
npm run tauri -w @atris-share/desktop -- build --debug --no-bundle
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The first command builds a native debug executable using embedded frontend assets
and staged runtime resources. It does not create an installer. Native tests need
`npm ci` and `npm run build:core` first. The packaged runtime smoke test also checks
stdin ownership shutdown; the Rust tests check native-owned startup/auth/shutdown.

`npm run tauri:build` configures an unsigned NSIS build; installer/signing/updater
and clean-machine acceptance belong to later release hardening. The first runtime
staging downloads the exact Node release's full license text from its upstream
tag; subsequent staging can reuse that version's local copy. No Node installation
is required by the staged native executable.

## Storage and vault

Default roots:

| OS | Data root |
| --- | --- |
| Windows | `%LOCALAPPDATA%\AtrisShare` |
| macOS | `~/Library/Application Support/AtrisShare` |
| Linux | `$XDG_DATA_HOME/AtrisShare` or `~/.local/share/AtrisShare` |

Set an absolute `ATRIS_SHARE_DATA_DIR` before launching to override it. For example:

```powershell
$env:ATRIS_SHARE_DATA_DIR = 'D:\AtrisShareData'
npm run tauri:dev
```

`.env.example` is documentation; the API does not automatically load `.env` files.
SQLite lives at `atris-share.sqlite` with WAL and foreign keys enabled. A single
migration owner uses `user_version`, rejects newer schemas and serializes first
initialization with `BEGIN IMMEDIATE`. Selection, projects, notes and audit survive
closing and restarting the process.

Windows vault records use DPAPI **CurrentUser** encryption and atomic encrypted
file replacement under `vault/`. Credential references are random UUID generations, hashed
for filenames. Secrets cross the PowerShell helper through stdin, not argv, and
are never written as plaintext. Startup probes protect/unprotect before reporting
the vault available. A missing/failed/unsupported vault returns unavailable and
does not fall back to SQLite or browser storage. macOS/Linux vault backends are
not implemented. Demo workflows never write social credentials. YouTube account
credentials use the vault, while SQLite holds only references and safe metadata.

Workspace memory and SQLite themselves are **not encrypted by DPAPI**; only vault
records are. The application data directory is private local user data and should
not be committed or distributed as sample content.

## Runtime lifetime and authentication

Browser development: the Vite plugin owns a loopback API on an ephemeral port. A
same-origin, host-checked bootstrap route requiring a custom request header returns
the session configuration. It has no cross-origin permission and no cache. The
frontend retains the token only in module memory, not local/session storage or URLs.

Native development and bundles: Rust owns the Node child, generates the random
32-byte session key, removes Node injection environment variables and obtains a
version/PID/loopback-address-checked readiness handshake. The only frontend IPC
returns this session configuration to the main local window. Native development
explicitly allowlists Vite's exact origin; bundles use only native Tauri origins.
Bundled debug and release apps resolve packaged resources, not checkout files.

All API operations require `Authorization: Bearer <session key>`. Host and origin
checks are additional boundaries; neither replaces authentication. API errors are
bounded codes, never raw request bodies, SQL errors or tokens. JSON inputs are
strictly validated and body sizes are limited. CORS preflight and the single-use
YouTube OAuth callback/static result page are unauthenticated; see [the boundary](YOUTUBE.md#local-api).

Closing the native window requests authenticated shutdown, waits, then kills/reaps
the owned child if necessary. Stdin EOF and a parent-PID watchdog also terminate
the API when its native owner disappears. The helper has no independent background
or tray mode in Phase 1. Closing the window stops local work.

The session key represents the current local application session, **not a social
OAuth identity**. This is a single-OS-user workspace, not a remote multi-user server.

## Workspace API

Every request is authenticated. JSON mutation bodies reject unknown fields.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/workspace` | Accounts, selection, selected account's projects, safe vault status and data path |
| POST | `/api/accounts` | `{displayName, platform}` creates a demo target |
| PUT | `/api/context` | `{accountId, projectId}` validates and persists selection |
| GET | `/api/projects?accountId=…` | List only this account's projects |
| POST | `/api/projects` | `{accountId, name, description}` |
| GET | `/api/memory?accountId=…&projectId=…` | Scoped notes; **both keys required**, empty project ID means account-wide |
| POST | `/api/memory` | `{context, kind, text, reviewState}` |
| PATCH | `/api/memory/:id` | Same fields plus `expectedRevision` |
| DELETE | `/api/memory/:id` | `{context, expectedRevision}` |
| GET | `/api/audit?accountId=…&projectId=…` | Last 50 current-scope events |

`context` is always `{accountId: UUID, projectId: UUID | null}`; omission is not an
implicit scope. Repository methods verify project ownership before querying.
Read/update/delete predicates include account **and** project; compound foreign
keys back up the application checks. Changing the active UI account never retargets
a captured operation. Old frontend reads are aborted/epoch-fenced before display.

Memory updates retain their source/time, increase revision and reject stale
updates/deletes with `409 revision_conflict`. Each successful mutation and its
content-free audit event commit together. Recognizable secrets are masked in user
notes/diagnostics, but automatic masking cannot identify every arbitrary credential;
the memory is not a credential store. Memory content never grants permission.

## Verification scope

Source tests cover authentication/origin/input boundaries, scope isolation across
reads/writes/deletes, migration concurrency, restart persistence, revision conflicts,
redaction, vault round trips and isolated runtime shutdown. Windows native debug
build and actual WebView CRUD/reload/DPAPI status/close were exercised locally.
Rendered checks covered both themes/languages, keyboard dialog focus, filtering,
deletion/cancellation and resizing. macOS/Linux native and signed installer
acceptance remain outside this milestone.
