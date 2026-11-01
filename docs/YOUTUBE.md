# YouTube — supervised publishing preview

Phase 2 code implements Desktop OAuth, refresh, channel verification, disconnect,
owned catalog pagination/linking, local-media import, immutable publication review,
resumable upload, processing and receipts/reconciliation. Tests exercise the actual
services through controlled provider transports, **not live Google**. Live connection
and publication acceptance are pending; neither is claimed here. Any live Google
flow requires a user-owned OAuth application, authorized channel and explicit human
approval before upload. Connecting an account alone does not authorize publication.

## Configure your Desktop OAuth application

1. In your Google Cloud project, enable **YouTube Data API v3**.
2. Configure Google Auth Platform branding/audience/data access. For an external
   application in Testing, add the authorized Google account as a test user.
3. Create an OAuth client of type **Desktop app**, not Web application.
4. Set the application client configuration in the environment used to launch
   AtrisShare, then start/restart the application. `.env` is not loaded automatically.

```powershell
$env:ATRIS_SHARE_YOUTUBE_CLIENT_ID = '<desktop-client-id>.apps.googleusercontent.com'
# If your Google Desktop client requires the downloaded client secret:
$env:ATRIS_SHARE_YOUTUBE_CLIENT_SECRET = '<desktop-client-secret>'
npm run tauri:dev
```

These are application configuration values, not a Google password, authorization
code or account access/refresh token. Desktop clients are public clients; their
client secret is not an authorization boundary. Do not commit the downloaded client
JSON. Account credentials are stored only in the Windows DPAPI vault. No secret
configuration/token CRUD endpoint is exposed to the frontend.

Google testing-mode grants may expire (commonly after seven days for external
Testing applications using YouTube scopes); reauthorization is expected. Public
distribution requires the appropriate Google OAuth verification and YouTube API
compliance requirements. OAuth verification and YouTube API audits are distinct;
check the project's current upload quota and supported privacy settings again
before upload acceptance rather than assuming historical restrictions still apply.

## Connect the exact channel

1. Open **Accounts / Hesaplar**. A working Windows DPAPI vault is required.
2. Enter your expected **channel ID**: `UC` followed by 22 characters. Find it in
   YouTube's advanced account/channel settings. A display name or `@handle` is not an ID.
3. Select **Continue with Google / Google ile devam et**. Consent opens in the
   system browser, outside the embedded WebView.
4. Choose the correct Google identity and YouTube channel/Brand Account. Grant:
   - `openid` — obtain the provider subject through the authenticated userinfo API;
   - `https://www.googleapis.com/auth/youtube.readonly` — verify/read the channel;
   - `https://www.googleapis.com/auth/youtube.upload` — supervised resumable uploads.
5. Return to AtrisShare. The API checks granted scopes, Google subject and the
   `channels.list(mine=true)` result against your expected ID before storing anything.

The 10-minute, single-use request uses random state and PKCE S256. Its listener
binds `127.0.0.1` on the runtime's random port; no public callback server, copied
authorization code, custom redirect scheme or browser scraping is used. Cancelling,
expiry or restart invalidates the pending request. A demo is never promoted to a
real account. Verified connections get separate stable IDs; reconnect preserves
that real account's projects/memory and refuses a different subject or channel.

**Verify connection** exchanges the refresh token and checks identity/channel again.
Missing permissions, revoked grants or an identity mismatch block the target and
request reconnection. Network failures are reported without revealing provider
response bodies. Catalog/link/upload operations refresh and re-verify identity,
scopes and destination; publishing requires exactly one matching channel. The
saved `connected` badge records the last verification,
not a permanent guarantee of access or authorization to publish.

## Studio media and owned catalog

Select an account **and project**, then open **Studio**. Imports stream into immutable
managed storage with SHA-256 and a **2 GiB** limit. Supported content is self-contained
MP4-family (`.mp4`/`.mov`) or WebM. A `.mkv` name is accepted only for WebM content;
general Matroska, playlists and external media references are rejected. Browser
preview/download uses authenticated Blobs up to **256 MiB**, never bearer-bearing
URLs; playback also depends on WebView codecs.

The **Channel** tab reads the verified destination's official uploads playlist in
pages of up to 50 items, returning owned-video metadata and a next-page token. It
does not download source footage. Link a selected local artifact to a channel video;
the server verifies video ownership again with `videos.list`. Artifacts, links,
timelines, exports and publication records remain account/project scoped; the remote
catalog request is account/destination scoped.

The manual editor saves one clip's trim, centered original/9:16/square crop, static
caption and audio gain with optimistic revisions, undo/redo and reopen. Export
creates a new artifact with progress/cancellation; retry means a new export from
the saved revision. The player previews the stored source/export, not a live render
of unsaved fields. Multi-track, split and proxies are not implemented. Inspection
and export require external FFprobe/FFmpeg; see [media tooling](../packages/media-engine/README.md).

## Review, dispatch and reconciliation

1. Prepare title, description, visibility, made-for-kids and subscriber-notification
   settings for a managed artifact. Creating a draft does not upload anything.
2. Review the exact destination, metadata, artifact bytes/MIME/SHA-256 and canonical
   payload digest. The immutable version-1 payload binds account, project, destination
   and artifact. Changes require a new draft and review.
3. Explicit **Approve upload** atomically consumes the review state, granting one
   dispatch with a **10-minute** window. Durable five-minute owner leases, renewed
   during work, fence competing claims. Identity/connection fencing, lease ownership,
   approval expiry and persistent revocation are checked before initiation/chunks.
   Upload bytes are copied to a temporary snapshot and verified against the approved hash.
4. The resumable session URL is encrypted in the vault; SQLite keeps only its
   reference. Upload progress and provider video ID persist. A final upload receipt
   means **processing**, not success; an explicit provider processing-success result
   produces the durable success receipt and scoped publication memory.
5. An interrupted/ambiguous upload becomes **uncertain**. **Reconcile** queries the
   existing session or recorded video before continuing. Remaining byte dispatch
   still requires the original unexpired, unrevoked approval. A missing/expired or
   unrecorded session never triggers blind re-initiation; no automatic transport
   retries or exactly-once guarantee are offered. Inspect remote state before
   deliberately creating another draft.

Cancelling a review prevents its approval. Cancelling an uploading/uncertain record
**persists dispatch revocation** and aborts local work; later reconciliation may read
remote status but cannot send more bytes. It cannot undo an in-flight request or
remote effects already accepted. Processing-only or terminal records currently
reject cancellation; cancellation is not a remote delete/unpublish operation.

## Disconnect and revoke

**Disconnect** removes the local credential while keeping projects, notes and
safe identity/audit metadata. Optionally select **Also revoke access at Google**.
Google revokes the project-wide grant for that identity, which can affect other
clients/channels. Known targets with the same provider subject are marked as
requiring sign-in after a confirmed revocation. Other affected clients must detect
revocation when they next use/verify their grant.

If revocation fails, the target is blocked and the encrypted credential is retained
for an explicit retry. You can retry the disconnect dialog or remove the grant in
[Google account permissions](https://myaccount.google.com/permissions). A local-only
disconnect does not claim that the remote grant has been revoked.

Credential updates use new immutable vault generations plus a transactional SQLite
revision check, so a stale refresh cannot replace/delete a newer connection's
credential. A crash between a vault write and SQLite commit can leave an unreferenced
encrypted file; automatic orphan-vault cleanup is not implemented. Do not remove
referenced vault records manually.

## Local API

All `/api/` routes require the per-launch bearer token and allowed origin/host.
Mutation bodies are strict JSON except the raw media-import stream. No route accepts
caller-supplied access/refresh tokens or resumable session URLs.

| Method | Route | Body / result |
| --- | --- | --- |
| GET | `/api/youtube` | Safe configured/available flags and requested scope names |
| POST | `/api/youtube/sessions` | `{expectedChannelId, accountId?}`; account ID is required for reconnect |
| GET | `/api/youtube/sessions/:id` | Safe pending/result state, expected channel, expiry and bounded error code |
| POST | `/api/youtube/sessions/:id/open` | Reopen the internally generated authorization URL |
| POST | `/api/youtube/sessions/:id/cancel` | Cancel the pending request |
| POST | `/api/youtube/verify` | `{accountId, destinationId}` |
| POST | `/api/youtube/disconnect` | `{accountId, destinationId, revoke: boolean}` |
| GET | `/api/youtube/catalog?accountId=…&destinationId=…&pageToken=…` | Owned metadata and `nextPageToken`; omit `pageToken` for the first page |

Studio media, timeline, render and publication routes are documented in
[the local API reference](LOCAL-WORKSPACE.md#studio-api). `pageToken` is a pagination
cursor, not a credential; bearer tokens remain in headers.

Only `GET /oauth/youtube/callback` and its static result page bypass bearer auth;
the callback requires the matching one-use state and PKCE exchange. It redirects
to a fixed query-free page with no external resources, no referrer and restrictive
CSP. It never renders provider text, codes, tokens or the runtime session key.

## Acceptance still required

Using a user-owned Desktop OAuth client and authorized test channel: accept live
connect/cancel/deny, refresh, restart and disconnect/revoke, then the implemented
import → review → explicit approval → upload → processing → receipt/reconciliation
flow. Choose visibility deliberately; public publication needs its own explicit
human review. Controlled-provider tests are not evidence of live Google acceptance.
Google app verification, API audit, quota and privacy restrictions still apply.

Official references (checked 2026-11-01):

- [Google Desktop OAuth / PKCE / loopback / revoke](https://developers.google.com/identity/protocols/oauth2/native-app)
- [YouTube installed application OAuth and scopes](https://developers.google.com/youtube/v3/guides/auth/installed-apps)
- [YouTube channels.list](https://developers.google.com/youtube/v3/docs/channels/list)
- [YouTube videos.insert and upload restrictions](https://developers.google.com/youtube/v3/docs/videos/insert)
