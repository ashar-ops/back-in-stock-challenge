# Submission preparation

## Facts to include
- Product: Restock, a back-in-stock email alert service.
- AI tool used to implement: Qoder. The user also supplied a Gemini planning/code draft, which was reviewed and substantially replaced to address reliability and security gaps.
- Repository URL: not published yet.
- Live application URL: not deployed yet. The localhost demo is not a durable public deployment.
- Admin access: share the hosted admin password privately, not in the public repository.
- Time: implementation began 2026-11-08T01:41:06Z. Final local code/browser/Node 24 validation checkpoint: 2026-11-08T02:02:48Z, approximately 22 minutes. Deployment is not included and is not complete; record its actual additional time before submitting.
- Personal availability, timezone, full-time commitment, and Upwork profile should be confirmed by the applicant rather than inferred from the draft.

## Before sending the proposal
- [ ] Authorize GitHub access and publish the source repository, excluding all secrets and local data.
- [ ] Build/run the Docker image on an actual Docker host.
- [ ] Deploy with a persistent volume and the hosted sandbox credentials.
- [ ] Set PUBLIC_URL to the actual HTTPS application origin.
- [ ] Save that origin in the hosted challenge dashboard.
- [ ] Verify duplicate events, phantom events, injected email failures, app restart, and mobile UI on the hosted instance.
- [ ] Copy the real repo/live URLs and verified total time into the proposal.

## Draft (use only after the checklist is complete)

Hi,

I built Restock for your back-in-stock challenge. It includes a responsive embedded signup form, password-protected operations dashboard, mobile-friendly email, and a Dockerized service with persistent SQLite storage.

The delivery flow verifies actual stock, atomically deduplicates open requests and webhook receipts, and retries failures without waiting for another webhook. Persisted email payloads and request-specific idempotency keys protect against duplicate acceptance after a timeout or restart. Unresolved deliveries are surfaced for review rather than silently dropped or blindly resent.

Repository: [insert the published repository URL]
Live application: [insert the verified live URL]
AI tools: Qoder; Gemini planning material was supplied before implementation.
Time taken: [insert the actual elapsed time and any separate deployment time]

[Add your personally confirmed working hours, timezone, and full-time availability.]
