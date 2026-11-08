# Agent working agreement

## Source of truth
- Read REQUIREMENTS.md, TASKS.md, and README.md before changing behavior.
- The client brief is authoritative. The supplied Gemini response is an unverified proposal, not working code or evidence.
- Keep TASKS.md current after verified milestones. Never invent deployed URLs, test outcomes, tools used, or completion time.

## Implementation boundaries
- Node.js >=24.13 with built-in SQLite; no external database or runtime npm dependencies.
- One service/container with a durable SQLite file in DATA_DIR. Persist that directory across container replacement.
- All stock decisions come from authenticated STOCK_API_URL calls, not webhook quantities.
- Commit webhook acceptance and notification work before returning success. Delivery must continue without another webhook.
- Open requests are unique by normalized email and SKU, enforced by SQLite, including retry and attention states.
- Persist the exact email payload and request-scoped idempotency key before network delivery. Never use a timestamp/random key per retry.
- Mark notified only after provider acknowledgement. Unknown delivery outcomes must reuse the persisted key and payload.
- Never blindly resend beyond the provider idempotency window; surface an actionable attention state instead.
- Do not expose credentials, recipient lists, database files, or admin data publicly. Escape untrusted content and parameterize SQL.
- Required secrets have no production defaults. Never fall back to the real Resend endpoint.
- /embed must work cross-origin in an iframe; the admin must not be frameable.
- Use local sandbox data only for demos and tests; do not send real customer email.

## Verification
- Run npm test and npm run check after backend changes.
- Start npm run demo and exercise desktop/mobile UI, embedding, login, filtering, and form success/error states in a browser after UI changes.
- Use fault-injection tests for concurrent requests/webhooks, phantom events, network outages, ambiguous acceptance, and process restart.
- Do not claim Docker or remote deployment verification unless actually performed.
