# Challenge requirements

Sources: the two user-supplied attachments; client brief at https://github.com/yitzi-farla/back-in-stock-challenge/blob/master/BRIEF.md and public sandbox at https://harness-production-e601.up.railway.app/challenge (checked 2026-11-08).

## Acceptance criteria
- GET /embed: responsive, accessible email + SKU form suitable for a third-party iframe; useful loading, success, duplicate, and error states.
- POST /api/requests: JSON { email, sku }; validate and normalize input; atomically prevent duplicate open requests.
- POST /webhooks/stock: JSON { event_id, sku, quantity, ... }; require X-Webhook-Secret; durable acceptance and concurrent deduplication.
- Independently confirm stock with GET STOCK_API_URL/{sku}, with Bearer STOCK_API_KEY. Never believe the webhook quantity.
- Handle duplicate events, different simultaneous events, repeated subscriptions, phantom restocks, API failures, and timeouts without losing queued work.
- Automatically retry transient failures; preserve request, retry, and notification state across process restarts.
- Send responsive HTML plus plain text through POST RESEND_BASE_URL/emails with the Resend JSON contract and Bearer RESEND_API_KEY.
- Use a stable, persisted request-specific Idempotency-Key and immutable payload across retries. State the actual distributed-delivery limitations rather than claiming unconditional exactly-once delivery.
- GET /admin: password-protected, useful request statuses and notification timestamps; no public recipient data.
- Polished customer form, admin dashboard, and email, including mobile layouts.
- Working Dockerfile: docker build then docker run with the six brief environment variables must start on PORT; no separate DB/service setup.
- README: environment variables, local/Docker/deployment instructions, durability and duplicate/missed-email strategy.
- Submission: public GitHub repository (or public container image), working live application, actual AI tools used, and honest elapsed time. The brief calls live hosting optional, but the job listing requests it, so treat it as a delivery target.
- Only sandbox customer data and credentials.

## Decisions
- Dependency-free Node HTTP server and built-in SQLite, WAL mode and full synchronous commits.
- Database-enforced open-request uniqueness and durable per-request work scheduling; persisted webhook receipts wake requests.
- Background reconciliation also checks waiting requests, covering webhook loss and already-in-stock subscriptions.
- Atomic lease claims prevent parallel workers from claiming the same row; stable provider idempotency covers crash/timeout ambiguity.
- Retries use bounded exponential backoff and Retry-After. Permanent delivery errors and expired idempotency windows are visible, not silently discarded.
- Storefront, iframe, and dashboard are lightweight local HTML/CSS/JS. Cookie admin sessions also support HTTP Basic for reviewers.

## Problems in the supplied draft to avoid
- A newly timestamped idempotency key on every attempt can duplicate accepted emails.
- Recording an event as processed before the network work succeeds can permanently lose retries.
- Merely leaving a request pending does not retry it without another event.
- UNIQUE(email, sku, status) prevents multiple historical notified requests.
- Unescaped template input enables injection; optional webhook auth and a default admin password are unsafe.
- Claimed tools, 35-minute completion, exactly-once delivery, and deployment links in the proposal are not verified facts.
