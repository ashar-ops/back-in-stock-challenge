# Delivery tracker

Started: 2026-11-08T01:41:06Z. Tool used: Qoder. Gemini planning material was supplied by the user. Do not claim Claude Code or Cursor were used for this implementation.

## Plan
- [x] Review both attachments and inspect the empty workspace.
- [x] Record acceptance criteria, security constraints, and agent guidelines.
- [x] Implement durable service, stock verification, delivery retries, and admin authentication.
- [x] Build responsive storefront, iframe form, admin dashboard, and HTML email.
- [x] Provide local demo against the client-supplied sandbox server.
- [x] Verify automated concurrency, failure, and restart scenarios.
- [x] Exercise UI in a real browser at desktop and mobile sizes.
- [x] Package Docker build and deployment instructions.
- [x] Verify Docker build/run with durable storage (built and run by Railway; restart and container-replacement persistence verified; no local Docker installed).
- [x] Publish repository (user pushed initial commit; remote main verified).
- [x] Deploy a persistent live instance (Railway trial, one replica, persistent volume, sleep disabled).
- [x] Connect and validate the hosted client harness (app URL saved; phantom, duplicate, burst, failure-recovery, and auth checks passed).
- [x] Prepare honest submission details and final verification report.

## Initial local implementation environment (historical; see hosted delivery preparation below)
- The workspace began empty and was not a Git repository.
- Available shell runtime: Node v26.13.0, npm 11.20.0; built-in SQLite works.
- gh, docker, railway, cloudflared, and ngrok are not currently on PATH.
- No hosting account, GitHub account authorization, or existing sandbox candidate credentials have been provided.

## Validation results
- The supplied local harness confirmed canonical duplicate signup, rejection of invalid webhook secrets, phantom-restock suppression, eight concurrent duplicate webhooks, recovery from two injected email HTTP 500 failures, and exactly one accepted email with a stable idempotency key. The request recorded three attempts and a notification timestamp.
- The harness writes its own JSON state on a 250ms delay; an initial immediate disk assertion read stale state. Rechecking after its flush confirmed the accepted email (an observation timing issue, not a delivery failure).
- The local demo is running with persistent sandbox data under ignored `.demo/`.
- Node 24.13.0 is available through npm exec for minimum-runtime verification.
- Git initialized on `main`; no commit or remote publication has been performed.
- Final local verification checkpoint: 2026-11-08T02:02:48Z (~22 minutes from the recorded start; excludes uncompleted deployment).
- 50/50 automated integration tests pass on both the installed Node 26 runtime and the minimum supported Node 24.13.0 runtime. Coverage includes concurrent distinct/duplicate webhooks, canonical requests, partial recipient failure, stock/email failures, Retry-After throttling, immutable retry payloads, timeout ambiguity, permanent-error review, expired idempotency windows, SQL/input/auth/CSRF boundaries, restart persistence, simultaneous SQLite workers, and an actual abrupt process kill after provider acceptance.
- All JavaScript syntax checks pass. Node 24 emits its expected experimental SQLite warning; no test failures occur.
- Real Chrome browser checks pass for signup, duplicate requests, network/rate-limit errors, product selection, cross-origin iframe submission, hostile SKU text, password login/logout, search/status filters, empty results, retry confirmation/cancellation, and catalogue outages.
- Desktop and 390px/320px layouts were exercised; storefront, embed, admin, and email have no page-level horizontal overflow. Admin tables intentionally scroll within their container. Screenshots were reviewed and are saved under ignored `artifacts/`.
- The final app was restarted against the existing local SQLite data, returned HTTP 200 at `/healthz`, and the sandbox store simulation was resumed.
- The in-app browser had no visible screenshot surface, so visual verification used real headless Chrome through temporary npm-exec Playwright tooling instead. No runtime dependency was added.
- Dockerfile is provided and its Node version/API compatibility was tested, but no Docker build/run has been performed because a Docker runtime is unavailable.

## Hosted delivery preparation — 2026-11-08
- The user published https://github.com/ashar-ops/back-in-stock-challenge; remote `main` matches local commit `ff77a3fe9ee12191aba62f1ccf5c9f6462a55e94`.
- The user created a Render account and populated ignored `.env`. All six required settings pass configuration validation, and authenticated hosted stock catalogue access returns 20 products. Email credentials and webhook integration have not yet been validated against the hosted harness.
- `.env` is untracked and ignored. None of the configured stock/email API keys or webhook secret appear in the 35 tracked files checked.
- Fresh verification passed all 50 integration tests and JavaScript syntax checks.
- With the user's explicit authorization, the public demo admin password was replaced in ignored `.env` with a cryptographically generated 32-character password; the value was not printed. `PUBLIC_URL` must still change to the actual hosted HTTPS origin.
- Render documentation confirms it builds the repository Dockerfile remotely; local Docker installation is not required. No Docker build has yet been performed.
- Render Free cannot attach a persistent disk, loses local SQLite changes on restart/redeploy/spin-down, and spins down while idle. It cannot satisfy this application's durability and independent-retry requirements. Paid compute plus a persistent disk, or another suitable host, needs the user's decision before proceeding.
- The available browser controls target Qoder's separate in-app browser, not the user's signed-in Chrome. Render navigation timed out and subsequent snapshots exposed only an empty page root, so authenticated dashboard access is not established.
- The user selected Railway, created an account, and completed the official CLI's browser sign-in. CLI tooling uses temporary `npm exec` without adding a project dependency. The user confirmed sign-in was done.
- Account inspection showed $5 in unused trial credit, 30 trial days remaining, no usage subscription, and no existing projects. No paid plan was activated. Trial expiration and possible outbound-network restrictions still need accounting for before final delivery.
- Created Railway project `back-in-stock-challenge` (`fa7efa58-398c-4f65-813e-315b59dda5bc`), production environment `416d1e5c-b0b7-40b7-b6b0-7b8374a7f628`, and service `restock` (`decbea05-41f5-42ee-852a-2d31f7a8f166`) using the trial.
- Attached 500 MB persistent volume `restock-volume` (`c027a8fb-b0ca-4b38-bb18-1a91d303d632`) at `/app/data`; Railway reports it READY.
- Reserved https://restock-production-27d9.up.railway.app on port 3000. This is a reserved address, NOT yet a working live application.
- Imported required environment variables privately, without printing secret values. Set hosted `PUBLIC_URL`, `DATA_DIR=/app/data`, one replica, sleep disabled, `/healthz`, and Dockerfile detection.
- Railway mounts volumes as root. Configured `RAILWAY_RUN_UID=0` with startup `sh -c 'chown node:node /app/data && exec su -s /bin/sh -c "exec node src/server.js" node'` so only volume initialization runs as root and the app drops to the node user. This startup still requires actual runtime verification.
- Connecting the GitHub source initially failed with `User does not have access to the repo`; after the user authorized Railway's GitHub integration, the source connected to `ashar-ops/back-in-stock-challenge` main and triggered deployment `c90bdefb-f4dc-4d55-acc0-9bfa6e96d9d8`.
- That build FAILED: Railway's builder rejects the Dockerfile `VOLUME` instruction ("docker VOLUME at Line 9 is not supported, use Railway Volumes"). Removed the `VOLUME` declaration; named-volume `docker run` behaviour is unchanged. With user authorization, committed and pushed the fix as `814a227d4d62f3c0b6976a8fe8c7df996c7aa04b`; Railway auto-deployed it as `b4a9a921-cc7b-4461-9f36-429d4cb9ac86` with status SUCCESS. This is a real host-side Docker build of the repository Dockerfile; no local Docker was installed or used.
- Live verification so far: https://restock-production-27d9.up.railway.app serves the storefront and `/healthz` (200). `/api/catalog` returns all 20 sandbox products, proving trial outbound HTTPS to the client harness works. Startup logs show the app listening with data directory `/app/data`; the root-only volume chown plus `su node` startup succeeded (a failure there would crash the container).
- Hosted admin login with the generated password returns 200 with Secure+HttpOnly cookie; authenticated `/api/admin/requests` works and unauthenticated access returns 401.
- Durability smoke test: created marked request `41f39863-049b-4d30-8199-dd1658860993` (`persistence-check@example.com`, `PERSIST-CHECK`), restarted the Railway service, and confirmed the same request survived in waiting state. Volume file browsing was not used because it requires registering SSH keys on the account; functional restart evidence was used instead.
- Live browser verification (Qoder in-app browser): hosted storefront renders the real 20-product catalogue with live stock states; `/embed?sku=TEE-ORG-WHT-M` prefills the SKU, a real form submission succeeded ("Your request is in"), an immediate repeat showed the duplicate message, and no console errors were logged. Test recipient: `hosted-browser-check@example.com`.
- Still pending: the user's private hosted-sandbox dashboard link (`/c/<token>`) is needed to save the app URL and inject email failures; hosted webhook/email fault checks and container-replacement persistence follow.

## Hosted harness verification — 2026-11-08 (live Railway instance)
- The user provided the private candidate dashboard link; it is stored only in ignored `.demo/hosted-dashboard.url`. Saved `https://restock-production-27d9.up.railway.app` as the candidate app URL (303, visible on dashboard).
- Wrong webhook secret rejected with 401 by the live app.
- Phantom restock: subscribed `phantom-check@example.com` to sold-out `TEE-ORG-WHT-M`; harness phantom event claimed quantity 12 and was accepted (200), but the request stayed waiting with 0 attempts and no email appeared in the harness inbox.
- Duplicate webhook: `duplicate-check@example.com` / `HOOD-FLC-GRY-M`; harness restock delivered the same event twice concurrently (both 200); exactly one accepted email, request notified after 1 attempt.
- Eight concurrent identical webhooks for `burst-check@example.com` / `KNF-CHF-20`: all returned 200, exactly one `duplicate:false`, one accepted email, notified after 1 attempt.
- Email failure recovery (controlled): stopped the simulation, injected two HTTP 500 failures, subscribed `retry2-check@example.com` to `TOTE-CNV-NAT`, restocked via harness. Result: 3 attempts, two `failed (injected 500)` inbox rows, exactly one accepted email, notified timestamp `2026-11-08T02:59:35.497Z`, last error cleared.
- Observation: the sandbox simulation had been running and its own customers consumed an earlier failure injection; two simulated recipients each show a failed then accepted email, an unplanned but consistent recovery demonstration. The controlled rerun above is the attributable evidence.
- Pre-replacement snapshot: 15 requests (11 notified, 4 waiting, 0 attention). Container replacement deployment `3fc78f1e-cfbf-4c0a-8b20-860ebac16eb0` reached SUCCESS; afterwards all 15 request IDs and the exact stats (11 notified, 4 waiting) were still present, proving SQLite durability across container replacement on the Railway volume.
- Hosted mobile verification in real headless Chrome: storefront (20 products), embed with prefilled SKU, and admin login have no page-level horizontal overflow at 390px and 320px, with zero page errors.
- The sandbox store simulation was restarted and is running (about every 30s), so the live instance receives ongoing realistic traffic.
- Railway trial usage at checkpoint: under $0.01 consumed of the $5 grant; no paid plan. Trial expires 30 days after 2026-11-08; the client should be told hosting is a trial unless the user upgrades.
- Hosted delivery checkpoint: 2026-11-08T03:01:44Z. Total elapsed from start ≈ 1 hour 21 minutes, including account setup and authorization pauses; local implementation/verification alone was ≈ 22 minutes.

## Remaining before sending the proposal
1. User confirms personal availability, timezone, and Upwork profile for the proposal.
2. Share the hosted admin password (generated value in ignored `.env`) with the client privately; never in the repository.
3. Optionally upgrade Railway before trial expiry for a lasting demo; the application itself is host-portable via the Dockerfile.

Final documentation was committed and pushed as `c3ab346` with user authorization; the automatic Railway redeploy reached SUCCESS with health 200, admin login 200, prior data intact, and the simulation still running.

## Next actions requiring user input or external access
1. Authorize Railway's GitHub integration for `ashar-ops/back-in-stock-challenge`, then recheck source state before connecting/retrying.
2. Have Railway build/run the supplied Dockerfile without installing Docker locally; verify mounted storage write permissions, application UID, health, sandbox connectivity, and no sleep.
3. Register the real working origin in the hosted harness, verify email credentials/webhook configuration, and repeat fault/restart checks including persistent data across container replacement.
4. Account for trial expiration and confirm any paid costs before upgrading. Finish SUBMISSION.md with actual working URLs and total time.

## Local handoff
- Start again with `npm run demo`; the current demo is running at http://localhost:3000.
- Local-only admin password: `restock-demo` (normal production startup has no default password).
- Requirements and future-agent rules: REQUIREMENTS.md and AGENTS.md.
- Run/setup/durability details: README.md. Honest proposal preparation: SUBMISSION.md.
