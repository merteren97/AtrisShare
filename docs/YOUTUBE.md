# YouTube connection — Phase 2, first slice

The Desktop OAuth connection, refresh, channel verification and disconnect paths
are implemented. Automated tests use a controlled Google transport; **an authorized
live Google account/channel has not yet been accepted**. Upload, publication intents,
human approval and receipts are the next slice. This build does not upload videos.

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
   - `https://www.googleapis.com/auth/youtube.upload` — permission needed by the
     forthcoming supervised upload flow; this slice does not use it to upload.
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
response bodies. Each future external operation must repeat its capability and
destination checks; the saved `connected` badge records the last verification,
not a permanent guarantee of access or authorization to publish.

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
Bodies are strict JSON and no route accepts caller-supplied access/refresh tokens.

| Method | Route | Body / result |
| --- | --- | --- |
| GET | `/api/youtube` | Safe configured/available flags and requested scope names |
| POST | `/api/youtube/sessions` | `{expectedChannelId, accountId?}`; account ID is required for reconnect |
| GET | `/api/youtube/sessions/:id` | Safe pending/result state, expected channel, expiry and bounded error code |
| POST | `/api/youtube/sessions/:id/open` | Reopen the internally generated authorization URL |
| POST | `/api/youtube/sessions/:id/cancel` | Cancel the pending request |
| POST | `/api/youtube/verify` | `{accountId, destinationId}` |
| POST | `/api/youtube/disconnect` | `{accountId, destinationId, revoke: boolean}` |

Only `GET /oauth/youtube/callback` and its static result page bypass bearer auth;
the callback requires the matching one-use state and PKCE exchange. It redirects
to a fixed query-free page with no external resources, no referrer and restrictive
CSP. It never renders provider text, codes, tokens or the runtime session key.

## Acceptance still required

Using an authorized test channel and user-owned Desktop OAuth client: connect,
cancel/deny, refresh, restart and disconnect/revoke. Then implement and accept
local-media import, immutable publication digest, per-attempt human approval,
resumable upload, processing and receipt/reconciliation. Connecting an account
does not authorize any of those publication side effects.

Official references (checked 2026-11-01):

- [Google Desktop OAuth / PKCE / loopback / revoke](https://developers.google.com/identity/protocols/oauth2/native-app)
- [YouTube installed application OAuth and scopes](https://developers.google.com/youtube/v3/guides/auth/installed-apps)
- [YouTube channels.list](https://developers.google.com/youtube/v3/docs/channels/list)
- [YouTube videos.insert and upload restrictions](https://developers.google.com/youtube/v3/docs/videos/insert)
