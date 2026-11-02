# Local data, deletion and reset policy

## What persists

Default application roots are `%LOCALAPPDATA%\AtrisShare` on Windows,
`~/Library/Application Support/AtrisShare` on macOS, and
`$XDG_DATA_HOME/AtrisShare` (otherwise `~/.local/share/AtrisShare`) on Linux.
An absolute `ATRIS_SHARE_DATA_DIR` overrides the root; identify the root actually
used by the running application before backing up or resetting anything.

SQLite (`atris-share.sqlite`, including its WAL/SHM sidecars) retains accounts,
projects, selection, scoped notes/provenance, content-free audit events, artifact
metadata, timeline revisions, render/publication state, AI run/proposal history,
transcripts and clip analyses. Managed media lives under `media/`. These remain
until explicitly removed/reset; there is no automatic age-based retention policy.
Showing only recent audit events does not prune older audit rows.

Windows `vault/` contains DPAPI CurrentUser-encrypted credential generations,
application OAuth configuration and upload-session secrets. SQLite holds references,
not plaintext vault secrets. Notes, SQLite, transcripts and media are **not encrypted
by DPAPI**. A copied vault is not a portable credential backup for a different
Windows identity/machine. Other OS vault implementations are not yet available.
Never commit the data directory or include it in a package or support attachment.

## Deletion semantics

Deleting a memory note removes that explicitly scoped, revision-checked SQLite row
and records a content-free deletion audit event. It is **logical deletion**, not a
guarantee that old bytes disappear from database free pages, WAL, backups, filesystem
snapshots or storage devices. It does not erase separate AI run/proposal history,
transcripts, media, publication receipts or copies already sent with explicit consent
to an external provider. Exported files and backups remain independent copies.

Disconnecting an account preserves its local projects/memory/media; it is not a data
reset. A local reset or deleting a note does not delete/unpublish provider content,
revoke remote authorizations, delete the AI CLI's credential store or undo a request
already accepted by a provider. Use the provider's explicit controls for remote
revocation/deletion. Deleting local publication state also removes reconciliation
information; review any pending/ambiguous remote effects first.

Normal completion/cancellation attempts to clean temporary media, speech and isolated
AI workspaces. Abrupt termination/power loss can leave scratch directories in the
application media directory or OS temp directory. No general crash-orphan collector
or orphan-vault garbage collection is promised. Do not delete directories based only
on a shared name prefix while another runtime could own them.

Diagnostics use bounded error codes/redaction and audit events do not contain note
text. There is no general automatic log-retention/rotation or secure-erasure service.
Developer terminals, OS crash reports, external tools and user-created support logs
have their own lifetimes. Redaction is defense in depth, not permission to put
credentials in notes/prompts. Never share grants, private speech, raw data/vault
files or provider response bodies as verification evidence.

## Stopped-app backup/reset

The preview's policy is **preserve user data across application updates/removal**;
installer/uninstaller behavior must still be verified in Phase 9. An uninstall is
not an accepted data-erasure mechanism. Reset is an explicit user maintenance action,
not a packaging/build operation. There is no automatic reset command in staging.

1. Review pending publications and preserve any remote IDs/receipts needed for
   reconciliation. Disconnect/revoke through the application/provider first if
   desired; filesystem deletion cannot perform remote revocation.
2. Quit the application completely (including tray/background mode if present).
   Stop development servers, workers, external MCP clients and all processes using
   this data root. Verify owned Node/media/CLI processes have exited. Do not copy or
   remove a live SQLite database or independently delete its WAL/SHM files.
3. Verify the exact root, including any `ATRIS_SHARE_DATA_DIR` override. If preserving
   state, copy the **entire stopped-app root together**, including SQLite sidecars,
   media and vault. Keep that backup private; restoring credentials may require the
   original Windows identity. Restore only while stopped and with a compatible schema.
4. For a deliberate local reset, remove only that verified AtrisShare root after
   deciding whether to retain a private backup. This removes local accounts, notes,
   receipts, transcripts, managed media and vault configuration. It does not remove
   originals imported from elsewhere, downloaded exports, backups, provider content
   or external tool/model/credential installations. User data loss is permanent if
   no backup exists; filesystem removal is still not guaranteed forensic erasure.
5. Relaunch to initialize an empty workspace, then configure tools/accounts as
   needed. Reconcile remote state explicitly rather than recreating and approving
   previously ambiguous publication jobs blindly.

For targeted leftover scratch cleanup, first establish that every potential owner
is stopped and that the path belongs to AtrisShare, then remove only confirmed
scratch material. Preserve managed artifacts and referenced vault records. Secure
device disposal/encrypted storage and third-party retention policies are outside
the application's logical-deletion guarantees. Clean-install/reset/upgrade evidence
belongs to Phase 9 and has not been established by packaging unit tests.
# Native preference isolation

When `ATRIS_SHARE_DATA_DIR` is explicitly set, native desktop preferences use that
same absolute directory, including close-to-tray. Otherwise they use Tauri's normal
application configuration directory. Test/recovery workspaces therefore do not
change the installed workspace's close behavior. WebView/OS notification settings
remain platform-managed and are not a credential backup.
