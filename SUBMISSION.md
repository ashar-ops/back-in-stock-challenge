# Submission preparation

## Facts to include
- Product: Restock, a back-in-stock email alert service.
- AI tool used to implement: Qoder. The user also supplied a Gemini planning/code draft, which was reviewed and substantially replaced to address reliability and security gaps.
- Repository URL: https://github.com/ashar-ops/back-in-stock-challenge
- Live application URL: https://restock-production-27d9.up.railway.app (Railway trial; one Docker container, persistent SQLite volume, sleep disabled).
- Admin access: share the hosted admin password privately, not in the public repository. The generated password is in the applicant's ignored local `.env` (`ADMIN_PASSWORD`).
- Time: implementation began 2026-11-08T01:41:06Z. Local code/browser/Node 24 validation checkpoint: 2026-11-08T02:02:48Z (approximately 22 minutes). Deployment and hosted-harness verification checkpoint: 2026-11-08T03:01:44Z. Total elapsed approximately 1 hour 21 minutes, including account setup and authorization pauses.
- Personal availability, timezone, full-time commitment, and Upwork profile should be confirmed by the applicant rather than inferred from the draft.

## Before sending the proposal
- [x] Authorize GitHub access and publish the source repository, excluding all secrets and local data.
- [x] Build/run the Docker image on an actual Docker host (Railway built the repository Dockerfile remotely; no local Docker was used).
- [x] Deploy with a persistent volume and the hosted sandbox credentials.
- [x] Set PUBLIC_URL to the actual HTTPS application origin.
- [x] Save that origin in the hosted challenge dashboard.
- [x] Verify duplicate events, phantom events, injected email failures, app restart, and mobile UI on the hosted instance (container-replacement persistence and 390px/320px layouts also verified).
- [ ] Copy the real repo/live URLs and verified total time into the proposal.
- [ ] Confirm personal working hours, timezone, and availability.
- [ ] Share the hosted admin password with the client privately.

## Draft (personal details still need the applicant's confirmation)

Hi,

I built Restock for your back-in-stock challenge. It includes a responsive embedded signup form, password-protected operations dashboard, mobile-friendly email, and a Dockerized service with persistent SQLite storage.

The delivery flow verifies actual stock, atomically deduplicates open requests and webhook receipts, and retries failures without waiting for another webhook. Persisted email payloads and request-specific idempotency keys protect against duplicate acceptance after a timeout or restart. Unresolved deliveries are surfaced for review rather than silently dropped or blindly resent.

Verified against your hosted sandbox: phantom restocks suppressed, concurrent duplicate webhooks accepted safely with one email, recovery from two injected email HTTP 500 failures (three attempts, one accepted email), and all requests preserved across a full container replacement. 50 automated integration tests pass, including an abrupt process kill after provider acceptance.

Repository: https://github.com/ashar-ops/back-in-stock-challenge
Live application: https://restock-production-27d9.up.railway.app
AI tools: Qoder; Gemini planning material was supplied before implementation.
Time taken: approximately 1 hour 21 minutes total (about 22 minutes for local implementation and verification, the remainder for deployment and hosted verification, including account setup pauses).

[Add your personally confirmed working hours, timezone, and full-time availability.]