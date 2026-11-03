# GitHub desktop updates

Release builds check the public GitHub **latest stable release** five seconds after
startup and every four hours while running. A newer version is downloaded and its
Minisign signature is verified against the public key bundled in the application.
Network/signature failures leave the current installation intact and offer Retry.

An untouched startup session installs after a 60-second grace period and restarts.
Any keyboard or pointer interaction outside the update notice disables automatic
restart for that session: the download remains ready for **Install and restart**.
This prevents updates from interrupting editing, importing or publishing. “Later”
hides the notice and cancels automatic restart. Settings → Application updates can
bring the update notice back. Normal application data is retained by the installer.

Windows uses the signed NSIS installer in passive mode and restarts after setup;
the owned local runtime is stopped before exit. Linux automatic installation uses
AppImage; `.deb` installations should be updated with the package manager.
Development/debug binaries never download or install updates.

## One-time release setup

The matching private signing key was generated locally at
`.atris-local/updater.key` (ignored by Git). Keep a secure backup. Do not generate a
different key for every release: existing installations trust the bundled key.

In this repository’s **Settings → Secrets and variables → Actions**, add:

- `TAURI_SIGNING_PRIVATE_KEY`: the full contents of the private key file.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the key password, if one is set. The initial
  locally generated key has an empty password, so this secret can be omitted.

Never upload the private key as a release asset, commit it, or paste it in an issue.
The public key is already configured in `apps/desktop/src-tauri/tauri.conf.json`.

Run **Actions → Desktop release** with a higher version. The workflow now requires
signing and collects `.exe`, `.AppImage`, `.deb`, both updater `.sig` files, checksums,
`latest.json`, and source/version provenance. A missing signature fails the release.
Both platform jobs must pass before the combined release is created.

Publish a non-draft, non-prerelease version to make it discoverable via GitHub’s
`releases/latest/download/latest.json` URL. Draft/prerelease builds remain available
for manual testing and do not replace the stable update channel. The repository and
assets must be publicly downloadable; the app embeds no GitHub token.

The first updater-enabled build must be installed manually once. Older builds do
not contain this updater. The code change alone neither publishes a release nor
changes an already-installed executable.
