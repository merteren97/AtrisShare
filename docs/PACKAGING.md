# Preview packaging policy

## Decision and acceptance boundary

The current preview is **unsigned and manually updated**. There is no automatic
updater, update feed, background download or updater artifact; Tauri explicitly
disables updater artifacts. Signing and an authenticated update design require a
separate decision before claiming either. Creating an NSIS installer or a CI
artifact is staging, not publishing or a release. Windows clean-machine install,
upgrade/uninstall, native UI and all-feature/live-provider acceptance remain the
final **Phase 9** gate. The manual release workflow targets Windows x64 and Linux
x64 installers; Linux clean-machine/runtime acceptance remains unverified. macOS
packaging is not enabled.

An update should stop the old application, preserve its data directory and install
the new application. Test migrations against a stopped-app backup before promising
upgrade compatibility. A newer-schema database is rejected, not silently downgraded.
Do not downgrade an installation with a newer database without an appropriate backup.
See [data policy](DATA.md).

## Build and validate

Use an exact-lockfile checkout, `npm ci`, the pinned Node runtime used by npm
scripts, Rust/Cargo and platform Tauri prerequisites. Staging invokes
`cargo metadata --locked` for the native host and `custom-protocol`; it requires
Cargo package sources even when only testing the Node runtime. It does not change
Cargo.toml/Cargo.lock. If native dependencies/features change, stage again after
their lockfile is updated. Target inventory is derived at execution, not a fixed
crate list. Cross-compilation is not supported by this staging script.

From the repository root:

```powershell
npm ci
node --test tests/packaging.test.mjs
npm run test:runtime
node scripts/package-inventory.mjs --verify apps/desktop/src-tauri/runtime
npm run build:core
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run tauri -w @atris-share/desktop -- build --ci --no-sign --bundles nsis -- --locked
```

The Tauri pre-build hook builds frontend assets and stages runtime resources; the
pre-bundle hook verifies the runtime again before generating the installer. CI
defines Windows native tests and unsigned NSIS staging with read-only repository
permissions and short-lived build artifacts; it does not sign, upload a release or
deploy. A workflow definition is not evidence of a successful GitHub run. Inspect
the installed package on a clean Windows machine in Phase 9; these checks do not
claim installer extraction, clean installation, WebView2 setup, or upgrade acceptance.

The root `test`/`check` scripts do not automatically include `packaging.test.mjs`;
CI calls it explicitly. `test:runtime` stages and exercises relocated Node/API/MCP.

## Manual GitHub release

`.github/workflows/release.yml` appears as **Desktop release** in GitHub Actions
after the workflow is present on the default branch. It has only `workflow_dispatch`;
ordinary pushes and tags do not publish releases.

1. Open **Actions → Desktop release → Run workflow** and select the source branch.
   The optional **version** field accepts SemVer such as `0.2.0`, `0.2.0-beta.1`
   or `v0.2.0` (the leading `v` is normalized). Leave it blank to use the checked-out
   source version. There is **no automatic patch/minor/major increment** and no
   lookup of the latest GitHub release. The tag is `v` plus the selected version;
   a suffix such as `-beta.1` automatically marks the release as prerelease.
2. Leave **draft** checked to create a draft. Uncheck it only when you intend the
   successful run to publish the release. The prepare job validates the input and
   rejects an existing version tag before starting the native builds.
3. Windows and Ubuntu 22.04 runners independently run application, packaging,
   release-contract, standalone-runtime and native tests, then build optimized
   installers. Linux installs GTK/WebKit 4.1/AppIndicator and bundling prerequisites;
   AppImage tooling uses extraction mode instead of requiring a FUSE mount.
4. The outputs are **Windows NSIS `.exe`**, **Linux `.deb` and `.AppImage`**, and
   one `SHA256SUMS-<platform>.txt` per platform. They are also retained for 14 days
   as `desktop-windows-x64` / `desktop-linux-x64` workflow artifacts.
5. Only after both platforms pass does the release job download all assets, require
   all three installers and verify their hashes. It records `release-manifest.json`
   containing the source commit, source version, selected version and asset hashes.
   It creates the new tag at that source `github.sha`, then a release with the
   installers, checksums and manifest. Repository
   write permission exists only in this final job; the normal `GITHUB_TOKEN` suffices.

An existing version tag is rejected; enter a new version for a new release.
The workflow does not overwrite existing tags or release files. If an
API/upload failure occurs after tag creation, inspect that partial tag/release
before retrying; a new run will not silently replace it. Concurrent runs for the
same branch queue rather than cancel an active publication.

### How a manual version is applied

The selected version is applied identically in each runner's **build workspace**:
root/desktop `package.json`, root/desktop npm lock entries, Tauri config, Cargo
manifest/root lock entry and domain `APP_VERSION`. API and MCP report that domain
version. Dependency versions are preserved. All application versions are checked
again before collecting installers; selecting only a release title cannot create
a setup with an older embedded version.

This overlay does not commit or push version changes to the source branch. A tag's
source files may therefore retain the source version: the manifest explicitly
records both versions and whether an override was applied. To reproduce the
metadata overlay after checking out that source commit, use the same value:

```powershell
$env:RELEASE_VERSION_INPUT = "0.2.0"
node scripts/release-package.mjs prepare
```

`node scripts/release-package.mjs metadata` validates the currently checked-out
versions without changing them. A blank `RELEASE_VERSION_INPUT` selects those
versions. Neither command performs an automatic increment.

Packages are unsigned and updates remain manual. The workflow definition and local
checks are not evidence of a completed hosted Linux build or a clean installation.

## Fail-closed staging and resource inventory

`scripts/stage-runtime.mjs` takes an exclusive `runtime.lock`, removes the previous
staging directory, and builds into a fresh sibling `.runtime-stage-*` directory.
It collects notices, generates the strict allowlisted resource inventory with
SHA-256 and byte lengths, verifies it, and renames it to `runtime/`. Failure removes
partial and previous output; a failed pre-build must not package an old runtime.
A competing staging invocation fails without removing the active invocation's lock
or output. If the staging process itself is forcibly killed, stop all build/staging
processes before removing an abandoned `runtime.lock` and `.runtime-stage-*` directory,
then re-stage. Never bypass a failed staging hook and package residual resources.

`manifest.json` lists every runtime resource except itself, plus application/Node
version, host platform/architecture and hashes of the packaging scripts/config,
manifests, lockfiles and application LICENSE/NOTICE. Unlisted files, missing resources, directories/symlinks,
empty files, changed hashes, incompatible architecture/platform and incomplete
dependency inventory are rejected. The verifier can compare packaging inputs with
the checkout. Hashes detect accidental mutation; they are **not a signature**, an
attestation of every source input, or proof that an installer contains these bytes.

Packaged resources include Node, `api.mjs`, `mcp.mjs`, applicable linked legal-comment
sidecars, Node/Zod licenses, application `LICENSE.txt`/`NOTICE.txt`, grouped full
third-party notices, `dependency-inventory.json` and `manifest.json`. Application
licensing is also configured for the installer. Runtime tests copy resources outside
the checkout and use the bundled Node to start the API and complete an official-SDK
MCP handshake/tool call against a synthetic loopback fixture. This is standalone
runtime engineering evidence, not live-provider or installed-app acceptance.

## License collection and its limits

- API/MCP: actual esbuild input graphs, installed versions checked against npm lock
  entries, full root license/notice files and nested license directories.
- Frontend: conservative installed production/optional/peer dependency closure from
  the desktop manifest, checked against the local lock. This includes some material
  Vite may tree-shake; it is not represented as exact emitted-code reachability.
- Rust: reachable target-filtered, locked Cargo packages, including build/proc-macro
  dependencies and `custom-protocol`. This is deliberately broader than linked code.
- Missing package text is a packaging error, not silently replaced by an SPDX label.
  For npm archives omitting licenses, registry metadata must match the locked integrity
  and installed identity; its `gitHead` identifies the upstream commit. Cargo archive
  omissions use `.cargo_vcs_info.json` and the declared GitHub repository. Only license
  files at that immutable commit are used, with URL/commit/content hashes recorded.
  Unsupported provenance, unavailable network or unresolved texts fails staging.
- `libappindicator-sys@0.9.0` also omits its repository field. Its reviewed mapping
  to `tauri-apps/libappindicator-rs` requires the official registry source, exact
  `Apache-2.0 OR MIT` declaration, archive VCS commit
  `eafd1e3682a1247f595410266091e9684021cb6f` and `sys` package path. Both original
  root licenses are fetched at that commit and recorded with content hashes. A
  changed version/identity cannot inherit the mapping. This fixes Linux runtime
  staging while retaining the complete-license requirement.
- One reviewed exception is deliberately explicit: `react-remove-scroll-bar@2.3.8`
  omits its license and its published `gitHead` is unavailable. The collector binds
  the exact locked npm integrity to the author's later LICENSE-addition commit
  `7301c160fda44cb8cf2b9fdfde61efad35736196` and expected text SHA-256. Notices and
  inventory label it as a **later upstream notice requiring distribution review**,
  not the original release snapshot. A version/integrity change cannot reuse it.
- MPL-only packages shipping just the standard Exhibit A header retain that actual
  header alongside the full official Mozilla v2 license. Rust notices link versioned,
  unmodified upstream source archives; preserve source access on redistribution.
- Node's full upstream versioned license inventory is included. A previous Node text
  can be reused only from a fully hash-verified runtime with the same Node version.

`complete` means every component in the **declared collected graphs** has a license
declaration and collected full text; it is not legal approval. The inventory records
its graph coverage and limitations. Review mixed-license choices, bundled assets,
source-availability obligations and modifications before distribution. Rust standard
library/toolchain, OS/system libraries, WebView2 and NSIS tooling are outside the
Cargo package inventory and need a separate distribution review. No claim of a
complete installed-system or installer-toolchain SBOM is made.

## External tools remain external

FFmpeg/FFprobe, whisper.cpp and GGML speech models, OpenCode and its provider
credentials are not copied into staging or installed automatically. Existing
PATH/absolute-path configuration and unavailable-tool recovery apply. FFmpeg exports
use H.264/libx264, AAC and drawtext; any future binary/codec bundling needs a separate
build/license/source/patent review. Temporary verification binaries are not release
resources. Model licenses and external AI/provider terms are separate from AtrisShare's
Apache license. Do not put tool caches, credentials, user databases or media into
`runtime/`; the strict inventory rejects additional files.
