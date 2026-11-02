# Social publishing (Phase 7)

X, LinkedIn and TikTok official adapters are integrated into the authenticated local API, SQLite migrations and desktop **Compose** navigation. No live provider accounts were contacted during development. App provisioning and final live acceptance remain Phase 9. The integration examples below document the existing boundaries for contributors.

## Integration: storage and migration

`SocialStore` takes the existing SQLite handle, context resolver, audit callback and scoped artifact resolver. It never accesses `WorkspaceStore` private members from outside that class, opens a second production database, or changes `user_version`.

Implemented in `packages/storage/src/store.ts`:

```ts
import { SocialStore } from "./social-store.js";

// Class property:
readonly social: SocialStore;

// Constructor, after this.studio is initialized:
this.social = new SocialStore(
  this.db,
  scope => this.resolveContext(scope),
  (scope, action, id) => this.audit(scope, action, id),
  (id, scope) => this.studio.artifact(id, scope)
);
```

The only new public workspace helper required is `readonly social`. Existing `resolveContext`, projects, artifacts and account rows are reused. `SocialService.accounts()` supplies social connection metadata; existing `listAccounts()` continues seeing the account rows but its YouTube-only connection join does not return social grant details. There is no need to expose the database or vault.

In the owning migration transaction:

```ts
import { SOCIAL_MIGRATION_SQL } from "./social-store.js";

// Schema v8 adds social state after the earlier workspace/media tables.
if (row.user_version < 8) db.exec(SOCIAL_MIGRATION_SQL);
// Keep the existing migration's user_version update and foreign_key_check.
```

Exact exported SQL (no schema-version assignment):

```sql
CREATE TABLE social_configs(
  provider TEXT PRIMARY KEY, credential_ref TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0)
) STRICT;
CREATE TABLE social_grants(
  provider TEXT NOT NULL, app_key TEXT NOT NULL, subject_id TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider,app_key,subject_id)
) STRICT;
CREATE TABLE social_connections(
  account_id TEXT PRIMARY KEY REFERENCES accounts(id), provider TEXT NOT NULL,
  destination_id TEXT NOT NULL, subject_id TEXT NOT NULL, app_key TEXT NOT NULL,
  grant_epoch INTEGER NOT NULL, config_revision INTEGER NOT NULL,
  credential_ref TEXT, token_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL, data TEXT NOT NULL,
  UNIQUE(provider,destination_id)
) STRICT;
CREATE TABLE social_posts(
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  project_id TEXT NOT NULL, destination_id TEXT NOT NULL, data TEXT NOT NULL,
  session_ref TEXT, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  dispatch_revoked INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_revoked IN(0,1)),
  FOREIGN KEY(project_id,account_id) REFERENCES projects(id,account_id)
) STRICT;
CREATE INDEX social_posts_scope ON social_posts(account_id,project_id);
```

## Integration: local API

In `services/local-api/src/server.ts`:

```ts
import { SocialService, type SocialOptions } from "./social.js";
import { socialRoute } from "./social-routes.js";
import { SocialTextService, type SocialTextOptions } from "./social-text.js";

// Optional internal test seams in ApiOptions; never HTTP-configurable:
social?: Omit<SocialOptions, "mediaPath">;
socialText?: SocialTextOptions;

// After studio initialization:
const social = new SocialService(store.social, credentialVault, {
  ...options.social,
  mediaPath: id => studio.engine.path(id)
});
const socialText = new SocialTextService(store, options.socialText);

// AFTER existing Host/Origin/runtime-bearer authorization, BEFORE the normal route chain:
const socialResult = await socialRoute(
  social, request.method ?? "", url, () => body(request, 128 * 1024),
  { text: socialText, signal: requestAbort.signal }
);
if (socialResult) {
  send(response, socialResult.status, socialResult.body);
  return;
}

// Include social.close() AND socialText.close() before store.close(), including startup failure.
```

For the new `requestAbort` above, wrap the awaited route dispatch with these listeners. This propagates a browser disconnect to the owned model process and waits for its cleanup before the handler settles:

```ts
const requestAbort = new AbortController();
const abortSocial = () => {
  if (!response.writableEnded) requestAbort.abort();
};
request.once("aborted", abortSocial);
response.once("close", abortSocial);
try {
  // await socialRoute(..., { text: socialText, signal: requestAbort.signal })
} finally {
  request.off("aborted", abortSocial);
  response.off("close", abortSocial);
}
```

`SocialTextService` defaults to the actual `OpenCodeBridge`. To share an explicitly constructed bridge port, use `new SocialTextService(store, { bridge })`; the required port is only `discover`/`propose`. No new migration or workspace helper is needed for text assistance.

Preserve existing `WorkspaceError`/`ZodError` sanitization. Do not log request bodies, OAuth URLs, token replies or exception diagnostics. The adapter returns bounded local error codes. Remote reset/retry hints are available on internal `SocialRemoteError.retryAt`; publication writes are never retried automatically.

**Do not add an unauthenticated OAuth route to `server.ts`.** `SocialService` owns separate, bounded `127.0.0.1` callback listeners with Host checks, no cross-origin callback requests, single-use state/PKCE, static CSP-protected results, ten-minute expiry and shutdown cleanup. `social-browser.ts` uses the existing platform-launch pattern with a separate exact social OAuth allowlist; the existing Google-only browser helper is untouched. OAuth URLs/state/verifiers are not exposed to the panel.

### Authenticated JSON routes

| Method | Route | Body / response |
|---|---|---|
| GET | `/api/social` | `{ setup: SocialSetup[], accounts: SocialAccount[] }`, no config values/credential references |
| POST | `/api/social/config` | `SocialConfig`; vault-only replacement; invalidates old connections/approvals |
| POST | `/api/social/sessions` | `{provider, accountId?, expectedDestinationId?}`; reconnect requires both account and expected destination |
| GET | `/api/social/sessions/:id` | Public session state, verified candidate destinations |
| POST | `/api/social/sessions/:id/open` | `{}`; opens system browser again |
| POST | `/api/social/sessions/:id/cancel` | `{}`; fences pending exchange/selection, deletes pending vault generation |
| POST | `/api/social/sessions/:id/select` | `{destinationId}`; re-verifies identity/role before connecting |
| POST | `/api/social/verify` | `{accountId,destinationId}`; fresh `SocialCapabilities` |
| POST | `/api/social/disconnect` | `{accountId,destinationId,revoke:boolean}` |
| GET | `/api/social/posts` | Query `accountId`, **non-null** `projectId`, `destinationId`; up to 100 records |
| POST | `/api/social/posts` | `SocialDraft`; creates immutable preview, no upload |
| POST | `/api/social/posts/:id/approve` | `{target:{accountId,projectId,destinationId},digest}`; claims and dispatches one post |
| POST | `/api/social/posts/:id/reconcile` | `{target}`; receipt checks only, never creates posts or uploads bytes |
| POST | `/api/social/posts/:id/stop` | `{target}`; durable per-write dispatch revocation; does not promise remote deletion |
| GET | `/api/social/ai/setup` | Actual isolated CLI model discovery; `?refresh=1` explicitly refreshes the short cache |
| POST | `/api/social/ai/suggest` | Strict scoped text request below; returns an immutable ephemeral suggestion, not a post |
| POST | `/api/social/ai/cancel` | `{requestId,context,target}`; stops only that exact active request and awaits cleanup |

`GET posts` schedules read-only status checks for `processing` receipts at most once per fifteen seconds. Leases prevent simultaneous claims in different runtimes. Unknown outcomes require an explicit check; no blind replay. Crossposting consists of independent draft/approve operations, not an all-or-nothing transaction.

## Integration: desktop panel

```tsx
import { SocialPanel } from "./SocialPanel";

<SocialPanel
  language={language}                 // "en" | "tr"
  context={snapshot.context}          // explicit source account/project, or null
  onAccountsChanged={() => { void refreshWorkspace(); }}
/>
```

The parent owns navigation and mounting. The panel loads its social accounts, per-account projects and current source-project Studio artifacts through existing authenticated API helpers. It can create a missing target project. Each variant has its own explicit target/project, metadata, immutable preview, approval checkbox and digest. Editing invalidates the editor's preview selection; saved immutable previews can be explicitly selected for review again. There is no approve-all action.

Media approvals require a loaded/playable local video preview. Existing Studio proxies are preferred when present for the current source; original files use the existing authenticated Blob endpoint, including its 256 MiB ceiling. For larger assets create a Studio proxy first. For a saved cross-context post whose proxy is not in the currently loaded artifact list, the integration can supply the optional scoped loader:

```tsx
loadPreview={async ({ context, artifactId }, signal) => {
  // Resolve only this explicit artifact/context, prefer its verified Studio proxy,
  // then fetch through the authenticated Blob helper. Never return bearer-bearing URLs.
  return mediaBlob(`/api/media/${artifactId}/content?accountId=${context.accountId}&projectId=${context.projectId}`, signal);
}}
```

### Actual text-assistance backend and UI

The panel uses `/api/social/ai/setup` and `/api/social/ai/suggest` by default. There is no external `suggestText` hook to wire or fake model fallback. Setup uses the actual isolated OpenCode model listing; the user must explicitly choose one reported ID. The public one-shot bridge performs its own fresh model/config preflight immediately before inference.

```ts
// POST /api/social/ai/suggest
{
  requestId: string;             // UUID generated by the panel; used for scoped cancellation
  context: SocialContext;        // MUST equal the explicit target account/project
  target: SocialTarget;
  modelId: string;               // explicitly selected from discovered actual IDs
  instruction: string;           // required, 1–2000 characters
  text: string;
  includeMemory: boolean;        // explicit, off by default
  allowRemote: true;             // explicit text-sharing consent
}
```

Only the current variant, instruction, provider and explicit target context are sent. Optional memory is **confirmed notes from that exact target project only**: no account-wide notes, other projects, transcripts, media, browser context or implicit workspace context. The store port has only `resolveContext`, `listAccounts`, and `listMemory`; the service has no vault, publication, approval, timeline-write or MCP dependency. Context/destination are checked before discovery, immediately before the model call and after completion. Input cannot request additional permissions or inject authority fields.

The new `packages/ai-bridge/src/social-text.ts` adapter reuses the existing public, isolated `OpenCodeBridge.propose` one-shot API. Its fixed no-op edit envelope transports generated `caption` text; the adapter strictly checks the constants, extracts text/summary and discards all edit fields. It never applies an edit. This avoids modifying or bypassing private bridge internals and preserves verified OpenCode 1.19.5 isolation, deny-all tools, actual model selection, bounded UTF-8 JSONL, stdin-only prompts and awaited process-tree cleanup.

Bounds: 10,000-character current variant, 2,000-character instruction, 4,000 aggregate memory characters (at most twelve notes, 600 each), <=64 KiB final prompt, 2,000-character generated text and 600-character explanation. Memory truncation is explicit. Discovery is bounded to 30 seconds, the request to 120 seconds, with at most two active operations. CLI stdout/stderr limits remain those of the existing bridge. No prompt or suggestion is persisted in workspace SQLite; isolated CLI state is deleted after child-tree close.

The response is a frozen ephemeral `SocialTextSuggestion`: explicit target/context/model, source-text and instruction digests, memory digest/count/truncation, text/summary, session provenance, creation time and canonical suggestion digest. It grants no publication rights. The UI keeps it separate from the editor and offers Apply/Reject. Applying only replaces the variant text and invalidates its publication preview/consent; the user must create and approve a new immutable publication. Editing inputs, changing scope, disconnecting, cancelling or unmounting aborts/discards stale generation. Memory opt-in resets when the target project changes.

`socialText.close()` aborts and awaits all discovery/completion calls. Both an HTTP disconnect signal and the explicit scoped cancel route propagate cancellation to the bridge. Production uses the actual CLI; tests use controlled bridge/process fixtures without inference or provider operations.

## Configuration and provider gates

All actual app configuration and grant credentials, including refresh tokens and TikTok client secrets, persist only through `CredentialVault`. SQLite contains references, app-ID hashes, scopes, revisions, grant epochs and immutable payloads/receipts. Pending exchanged credentials are also vaulted; OAuth state/verifier exist only in expiring runtime memory. Signed upload URLs and upload tokens remain transient runtime values and are never returned to HTTP/UI or written to SQLite.

`SocialConfig` fields:

```ts
{
  provider, clientId, clientSecret?, callbackPort,
  nativePkceEnabled, loopbackApproved, organizationAccess, publicApp, audited
}
```

Flags express known app provisioning, not a bypass or automatic discovery of provider approvals. Actual OAuth/API responses remain authoritative.

| Provider | Implemented path | Gate / intentional constraint |
|---|---|---|
| X | Public native PKCE, identity, refresh/revoke; text and v2 chunked video posting | Requires fixed registered port >=1024 and `loopbackApproved`. Official current guidance documents HTTP loopback for local development, HTTPS for production; a generic production redirect exception is not assumed. No client secret accepted. |
| LinkedIn | Explicitly enabled native PKCE; OIDC member identity, member/org posts, Videos API | Requires `nativePkceEnabled`. No ordinary confidential web OAuth/broker is implemented. Organization discovery/posting requires provisioned scopes and approved administrator/content-admin role. DSC-only roles are excluded from organic posting. |
| TikTok | Desktop PKCE, identity, refresh/revoke, creator info and Direct Post video | Requires developer-owned client secret; shared desktop-secret distribution is not supported. `publicApp` must be true for posting. Unaudited clients require private accounts and SELF_ONLY. Provider scope/product approval remains mandatory. |

Callbacks:

```text
http://127.0.0.1:<port>/oauth/social/x/callback
http://127.0.0.1:<port>/oauth/social/linkedin/callback
http://127.0.0.1:<port>/oauth/social/tiktok/callback
```

X uses exact fixed-port registration. Enabled LinkedIn native flow supports random loopback ports. TikTok supports wildcard-port registration, e.g. `http://127.0.0.1:*/oauth/social/tiktok/callback`. X/LinkedIn use base64url SHA-256 PKCE; **TikTok desktop uses the documented hex SHA-256 encoding**.

Scopes:

- X: `tweet.read users.read tweet.write media.write offline.access`.
- LinkedIn member: `openid profile w_member_social`; optional organization mode adds `r_organization_admin w_organization_social r_organization_social`. The closed `r_member_social` permission is not requested or assumed. Native LinkedIn does not require refresh-token issuance; reconnect when a non-refreshable access token expires.
- TikTok: comma-separated `user.info.basic,video.publish`.

Disconnect fences the provider/app/subject grant across its destinations before asynchronous work. Remote X/TikTok revocation fences again after completion so a concurrent reconnect cannot survive a revoked grant. Failure retains the encrypted credential for explicit retry while blocking dispatch. LinkedIn `revoke:true` returns `social_linkedin_remote_revoke_unavailable`; local disconnect works, and remote removal belongs in LinkedIn's permitted-services settings.

## Immutable publication and reconciliation

`SocialDraft` contains:

```ts
{
  target: { accountId, projectId, destinationId },
  metadata: /* provider-discriminated exact schema */,
  media: null | { context: { accountId, projectId }, artifactId }
}
```

The server binds the verified provider subject, app hash, connection revision and actual artifact metadata/hash into `SocialPayload`, then computes the canonical SHA-256 digest. Source and destination contexts are separate for crossposting; no source-account inference occurs. Proxy/preview artifacts cannot be published.

Approval lasts **ten minutes**. Every provider mutation, including each binary chunk, checks durable lease ownership, digest, expiry, dispatch revocation, config revision and grant epoch, with fresh provider identity/organization role checks before the write. Creator info is refreshed at initialization/final publishing boundaries to avoid consuming TikTok's 20/min creator-info quota for every chunk. Snapshot bytes are copied/hash-verified before provider mutations, preventing source-file TOCTOU changes during upload.

Receipt fields are distinct: `jobId`, `mediaId`, `postIds[]`, `providerState`, `publicUrl`. IDs remain strings, including TikTok int64 JSON numbers. A durable `POST_DISPATCHING` marker precedes X/LinkedIn post creation; losing that response cannot be mistaken for a safe media-ready continuation.

- X: initialize → indexed append → finalize → bounded processing reads → create post. Successful post receipt is `data.id`.
- LinkedIn: initialize Videos → instructed ranges/ETags → finalize → processing reads → Posts API. Receipt is the **`x-restli-id` header**. Member posts without closed read permission remain `accepted`, not falsely verified.
- TikTok: fresh creator info → Direct Post init → sequential chunks → job status. `PUBLISH_COMPLETE` can succeed without public IDs for private posts. HTTP-200 error envelopes are checked.
- Signed upload requests receive **no account bearer token**, follow no redirects, and use validated provider HTTPS upload hosts/paths. Requests have a 30-second bound and JSON bodies a 1 MiB response limit.
- Long X/LinkedIn media processing can pause the dispatch. A read check can establish `MEDIA_READY` **only if post creation was never attempted**. The same immutable digest then needs a fresh human approval to create its post without repeating upload initialization.
- Missing receipts, interrupted dispatches and ambiguous remote mutation failures stay `uncertain`. Reconciliation never resends create/upload requests. Known provider denials fail with sanitized codes.

Initial conservative media envelope: X default-account 8 GiB/20 minutes; LinkedIn MP4 75 KB–500 MiB and 3 seconds–30 minutes (official Videos docs conflict with a 5 GB initialization field, so the narrower envelope is used); TikTok <=4 GiB and fresh creator duration/dimensions. Codec/FPS validation remains provider-enforced because the current shared `MediaProbe` has no codec/FPS fields. Premium extended X video limits are not advertised. The integrated API uses official `twitter-text@3.1.0` for exact weighted validation and the local debounced UI counter.

**Installed exact X weighting dependency**:

```powershell
npm install twitter-text@3.1.0 -w @atris-share/local-api
npm install -D @types/twitter-text -w @atris-share/local-api
```

```ts
import twitterText from "twitter-text";
const social = new SocialService(store.social, credentialVault, {
  ...options.social,
  mediaPath: id => studio.engine.path(id),
  validateXText: text => twitterText.parseTweet(text).valid
});
```

The production server injects this parser and `xTextMetrics`; an isolated service without that hook retains its conservative fallback. Empty-caption video posts are handled separately and do not incorrectly require `parseTweet("").valid`. `POST /api/social/x/text-metrics` takes `{text}` and returns weighted length, limit and validity without provider calls or URL text disclosure.

Schema v9 serializes remote refresh rotation through a provider/app/subject lease,
renewed while the bounded token operation runs. CAS still protects vault generations;
stale failures cannot fence a winning credential. Provider reset/Retry-After cooldowns
are persisted per account and survive restart. Read reconciliation explicitly checks
the immutable provider/subject/app/destination identity.

## TikTok required UI behavior

- Fresh creator info on target selection/verification and server-side validation at preview/dispatch boundaries; show creator nickname.
- Privacy has **no default** and uses returned options. Comment/Duet/Stitch start off; forbidden interactions are disabled/greyed out.
- Commercial disclosure starts off. If enabled, at least one brand type is required. Own brand → Promotional content; third-party/both → Paid partnership. Third-party branded content cannot be SELF_ONLY.
- Music Usage Confirmation is linked before consent. Third-party disclosure additionally links Branded Content Policy. Metadata changes reset consent. Media transfer starts only after the explicit per-post approval.
- Saved/restarted/scheduled TikTok reviews fetch fresh creator information, start privacy and review consent unselected, and require reselecting the immutable privacy/interaction/brand settings. A change requires a new draft. The approval route additionally requires fresh `tiktokConsent: true`; stored consent from schedule creation never suffices. Schedule generation/deadline is rechecked even for media-ready reapproval.
- Playable preview, editable caption, AI-generated disclosure and processing-status explanation are present. The renderer does not add an application watermark.

Direct Post excludes private/team-only upload utilities and arbitrary cross-platform content copying. OAuth alone cannot establish a valid product use case. TikTok inbox/draft handoff (`video.upload`), photos, text-only TikTok posts, ads, automatic provider deletion, and remote webhook servers are outside this adapter.

## Verification

```powershell
npm run build:core
node --test tests/social*.test.mjs
npm run typecheck -w @atris-share/desktop
```

The suite exercises real local callback listeners with injected official-provider transports, OAuth encoding/replay/cancellation, explicit destination selection, roles/scopes, immutable approvals, media snapshots, per-write TTL/revocation, cross-runtime refresh CAS, vault-only main/WAL persistence, X/LinkedIn/TikTok uploads/receipts, independent crossposts, bounded responses and no-blind-retry recovery. Text tests additionally cover actual reported model selection, exact-project memory opt-in, frozen suggestions, strict no-op carrier validation, stale-scope rejection, input/output budgets, sanitized errors, authenticated HTTP cancellation and real controlled Node child/grandchild cleanup through the existing bridge without inference.

Rendered standalone React verification used the real component and synthetic local API responses: EN/dark 1280px and TR/light 740px, no horizontal overflow, per-target approval isolation, empty TikTok privacy/interactions, disclosure/consent reset and legal links, config secret clearing/no browser storage, keyboard focus and a locally generated playable 360×640 WebM preview. This is not live provider/native acceptance.

The text-assistance addition was rendered against the actual new HTTP route/service factory with a controlled bridge (same-origin test proxy; no inference). Checks covered actual fixture-reported model IDs with no default selection, memory/consent off by default, instruction requirement, non-default model propagation, optional project memory counts, unchanged editor before Apply/after Reject, explicit cancellation, cancellation/stale-result rejection on project change, memory opt-in reset, and a target project different from the workspace source project. EN/dark 1280×860 and TR/light 740×560 remained keyboard-accessible with no horizontal overflow.

## Official contracts reviewed

- [X native apps/redirects](https://docs.x.com/resources/fundamentals/developer-apps), [OAuth](https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token), [v2 media](https://docs.x.com/x-api/media/quickstart/media-upload-chunked), [post creation](https://docs.x.com/x-api/posts/create-post), [limits](https://docs.x.com/x-api/fundamentals/rate-limits).
- [LinkedIn enabled native PKCE](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow-native), [OIDC](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2), [Posts](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-10), [Videos](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-10), [organization ACLs](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-10).
- [TikTok desktop](https://developers.tiktok.com/doc/login-kit-desktop/), [token management](https://developers.tiktok.com/doc/oauth-user-access-token-management/), [Direct Post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post/), [transfer](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide/), [status](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status/), [required UX/product eligibility](https://developers.tiktok.com/doc/content-sharing-guidelines/).
