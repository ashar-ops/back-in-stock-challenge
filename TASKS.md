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
- [ ] Verify Docker build/run with durable storage (Docker runtime unavailable).
- [ ] Publish repository and deploy a persistent live instance (account access required).
- [ ] Connect and validate the hosted client harness (hosted instance and candidate credentials required).
- [x] Prepare honest submission details and final verification report.

## Environment findings
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

## Next actions requiring external access
1. Authorize a GitHub account/repository and a persistent Docker host (Railway, Render with a disk, or a VPS). No remote repo has been created and no commit/push has been made.
2. Obtain the user's candidate credentials from the hosted challenge dashboard; keep these and its private URL out of source control.
3. Build/run the supplied image, mount `/app/data`, set all required environment variables and the real HTTPS `PUBLIC_URL`, and deploy.
4. Register that live origin in the hosted harness, repeat the fault/restart checks there, and finish SUBMISSION.md with actual URLs and total time.

## Local handoff
- Start again with `npm run demo`; the current demo is running at http://localhost:3000.
- Local-only admin password: `restock-demo` (normal production startup has no default password).
- Requirements and future-agent rules: REQUIREMENTS.md and AGENTS.md.
- Run/setup/durability details: README.md. Honest proposal preparation: SUBMISSION.md.
