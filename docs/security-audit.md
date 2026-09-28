# Security audit, 2026-09-28

Scope: `apps/server` (HTTP API, collaboration socket, auth, AI review, storage), the parts of `apps/web` that render untrusted content, and production dependencies. Method: code read of every route and trust boundary, `pnpm audit --prod` (no known vulnerabilities), and a test for each fix (`apps/server/src/security.spec.ts`, `e2e/tests/security.spec.ts`).

The access model this audit judges against is unchanged: **a room id is the capability.** Anyone holding one can read and edit that room, and sign-in is identity only. Findings are about what someone can do beyond that.

## Fixed

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | `/api/review` had no rate limit. Every call is billed by Anthropic or Google, so anyone could spend the API budget in a loop. | Per-client limit, `RATE_LIMIT_REVIEW_PER_MIN` (default 10). |
| 2 | High | The socket accepted frames up to 100 MiB (the `ws` default), with no per-socket rate and no limit on document size. One client could exhaust memory, fill storage, or make a room too large for anyone to join. | 2 MiB frames (`WS_MAX_MESSAGE_BYTES`), 200 messages/s per socket with 2x burst (`WS_MESSAGES_PER_SECOND`), 16 MiB rooms (`ROOM_MAX_BYTES`). An offending socket is closed (1008 or 1009) and the header shows why. |
| 3 | Medium | `?model=` on `/api/review` was passed straight to the provider, so a caller could route reviews to the most expensive model the key can reach. | Must be the default or a listed model, optionally narrowed by `REVIEW_ALLOWED_MODELS`. |
| 4 | Medium | Room ids, which are edit capabilities, were written to request logs in full. Logs outlive rooms and have more readers. | URLs are logged with the id replaced by a 10-hex-char SHA-256 tag, which is still enough to correlate one room's requests. |
| 5 | Medium | Behind Render's proxy, every client had the proxy's address, so any per-client limit would have been one shared limit. | `TRUST_PROXY` (set to `true` in `render.yaml`). |
| 6 | Low | `/api/validate`, `/api/review` and the observations endpoint accepted unbounded strings, non-finite numbers, negative retries and timeouts. The 1 MiB body limit capped the damage, but a single label could be the whole megabyte. | Ids at most 64 chars, labels and tech at most 200, notes at most 4000, coordinates and counts bounded and finite. |
| 7 | Low | The socket did not check `Origin`, so a foreign page that had learned a room id could drive the room from a visitor's browser. | Browser upgrades must come from this app's origin or `CORS_ORIGINS`. Non-browser clients (no `Origin`) are unaffected. |
| 8 | Info | Session JWTs were verified without pinning the algorithm. `jose` already refuses mismatched key types, so this was not exploitable. | Pinned to HS256. |
| 9 | Low | The observations endpoint had no rate limit, and each new room id it names creates a stored room. | Per-client limit, `RATE_LIMIT_OBSERVATIONS_PER_MIN` (default 120). `/api/validate` has one too (300). |

## Checked, no change needed

- **XSS.** The client never uses `innerHTML` or bypasses Angular's sanitizer. Labels, notes, AI findings and peer names are interpolated (escaped) or drawn on a canvas. Peer avatar URLs come from untrusted awareness state, but CSP `img-src` limits them to GitHub's and Google's avatar hosts.
- **OAuth.** `@fastify/oauth2` handles `state`. The post-login redirect is limited to a room-id path on this app's origin or a configured one (no open redirect). Session cookies are `HttpOnly`, `SameSite=Lax` and `Secure` in production. The provider access token is used once and never stored.
- **Injection.** Room ids are allow-listed before use as storage keys. All SQL is parameterised. Observation sources are allow-listed.
- **AI output.** Every finding must cite a real node or edge (`groundFindings`), and findings render as text. Prompt injection through labels can at worst produce a misleading finding that points at a real component.
- **Errors.** Upstream failures are mapped to fixed messages (`describeUpstream`) and never forward provider errors or credentials.
- **Dependencies.** `pnpm audit --prod`: no known vulnerabilities.

## Open, needs a decision

Each of these is a real exposure that the current design accepts. Whether it stays accepted is a product call, not a code fix.

1. **The observations endpoint has no credential.** Anyone who knows a room id can overwrite that room's evidence, which changes which findings fire. The rationale is that the same person can already edit every number by hand. That holds today. It stops holding once workspaces (task 7) make some rooms private, and the endpoint should then take a per-room ingest token.
2. **Room ids are the only access control.** Room ids are the first 12 hex chars of a `crypto.randomUUID()`, all random (48 bits). That can't be guessed, but anyone the link is forwarded to gets edit access, forever, with no revocation. Workspaces (task 7) are the fix.
3. **No way to delete a room.** Nothing removes a room from storage, and browsers keep a copy in IndexedDB. See `data-handling.md`.
4. **CSP `connect-src` allows any `ws:`/`wss:` host.** Tightening to `'self'` works in current Chromium and Firefox. It is left open because older Safari versions do not match WebSocket URLs against `'self'`. Low risk: `script-src` is `'self'`, so injected script is already blocked.
5. **`style-src 'unsafe-inline'` and `script-src-attr 'unsafe-inline'`** are needed by Angular's emulated encapsulation and the Critters stylesheet loader (see the comment in `app.ts`). Removing them means nonce plumbing through the Angular build.
6. **Rate limits are per process.** Two instances would each allow the full budget. This is fine on one Render instance. Scaling out needs a shared store (`@fastify/rate-limit` supports Redis).
7. **No per-IP limit on socket connections.** Each socket is bounded, but not how many one address opens. The Render proxy's own limits apply first.
