# Restock

A back-in-stock alert tool with a storefront, an iframe-ready signup form, a private operations dashboard, and responsive HTML emails. Node.js 24.13+; no runtime npm dependencies or external database.

Live demo: https://restock-production-27d9.up.railway.app (hosted on a Railway trial with a persistent volume; admin password shared privately with the reviewer).

## Run locally

```sh
npm run demo
```

The isolated demo runs the client-supplied sandbox locally, obtains sandbox credentials, and starts the app. It prints the app, sandbox dashboard, and local-only admin password. No real emails are sent. Data is saved in `.demo/`. Node 24.13+ is required.

For the hosted sandbox, sign up at https://harness-production-e601.up.railway.app with the invite code in the supplied challenge. Copy `.env.example` to `.env` and fill in the generated credentials and your admin password, then:

```sh
npm start
npm test
npm run check
```

## Verification

`npm test` runs the dependency-free integration suite using isolated local stock/email mocks and temporary SQLite databases, including a real abrupt-process crash. External network calls are blocked by the test helper.

With `npm run demo` running in another terminal and Chrome installed, run the real-browser checks:

```sh
npm exec --yes --package=playwright -- node tools/browser-check.js
```

This downloads Playwright into npm's tool cache, not the application dependencies. Use `BROWSER_CHANNEL=msedge` if only Edge is installed. Checks cover actual form submission and duplicate handling, errors, login/logout, admin filters, catalogue outages, injection input, and desktop/390px/320px layouts. Screenshots are written to ignored `artifacts/`. The browser script deliberately only targets localhost; it does not submit data to a production service.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `STOCK_API_URL` | Yes | Complete stock endpoint; append `/{sku}` for individual stock checks |
| `STOCK_API_KEY` | Yes | Stock API bearer token |
| `RESEND_API_KEY` | Yes | Sandbox email API bearer token |
| `RESEND_BASE_URL` | Yes | Sandbox origin; the app appends `/emails`. No fallback to real Resend |
| `WEBHOOK_SECRET` | Yes | Required `X-Webhook-Secret` on every stock webhook |
| `ADMIN_PASSWORD` | Yes | Admin sign-in password; no default in normal mode |
| `PORT` | No | Listening port, default `3000` |
| `DATA_DIR` | No | SQLite directory, default `./data` (`/app/data` in Docker) |
| `PUBLIC_URL` | For hosting | Actual HTTPS application origin. Enables email item links and secure cookies; required for login behind HTTPS proxies |
| `FROM_EMAIL` | No | Sender, default `Restock <onboarding@resend.dev>`; use a verified sender outside the sandbox |
| `RECONCILE_INTERVAL_MS` | No | Recheck waiting requests, default `60000` |
| `NETWORK_TIMEOUT_MS` | No | Timeout per upstream request, default `5000` |
| `WORKER_LEASE_MS` | No | Crash-recovery lease, default `30000`; at least 3× network timeout |
| `RETRY_BASE_MS` | No | Initial retry delay, default `1000` |
| `WORKER_POLL_MS` | No | Queue polling interval, default `250` |

Never publish `.env`, `.demo/`, `data/`, database files, or the private sandbox dashboard URL.

## Docker

```sh
docker build -t restock .
docker run --name restock -p 3000:3000 --env-file .env -v restock-data:/app/data restock
```

It also starts with only the six required environment variables; no migration command, npm installation, or separate database is needed. The container runs as the non-root `node` user and honours `PORT`. The named volume shown above preserves state across restarts and container replacement. SQLite needs a local persistent filesystem; do not use a network filesystem or an ephemeral serverless host.

For a host-assigned port, expose that port rather than assuming 3000. The image health check uses the configured port and `/healthz`.

## Endpoints

- `GET /`: catalogue and customer experience.
- `GET /embed?sku=MUG-STN-SAGE`: standalone or cross-origin iframe signup form. Omit SKU for manual input.
- `POST /api/requests`: JSON `{ "email": "customer@example.com", "sku": "MUG-STN-SAGE" }`. Returns 201 for a new request, 200 for a duplicate open request.
- `POST /webhooks/stock`: JSON `{ "event_id": "evt_1", "sku": "MUG-STN-SAGE", "quantity": 5 }` with `X-Webhook-Secret`. Accepted and duplicate receipts return 200; conflicting reuse of an event ID returns 409.
- `GET /admin`: password sign-in. HTTP Basic is also supported with any username and `ADMIN_PASSWORD`.
- `GET /admin/email-preview`: protected responsive email preview.
- `GET /healthz`: process/database liveness (not a guarantee of upstream availability).

To embed, use an iframe pointing to your deployed `/embed?sku=...` with `title="Back-in-stock email alert"`, width `100%`, and a height of at least 650px. The embed explicitly allows framing; admin pages prohibit it. No cross-origin API CORS access is needed because the form executes on the app's origin.

## Why emails are not silently lost or duplicated

1. SQLite WAL + full synchronous commits persist requests, webhook receipts, email payloads, scheduling, and leases. A partial unique index allows only one open request per normalized email/SKU, while permitting future subscriptions after notification.
2. Webhook receipts and waking waiting requests are committed together **before** HTTP success. Event IDs are not interpreted as proof of completed email delivery. Even quantity-zero events are only hints.
3. A worker atomically leases due requests. It verifies actual stock using the authenticated stock API **before every send attempt**. Concurrent webhooks cannot create additional deliveries for the same request.
4. Before sending, the worker persists the exact Resend payload and uses `Idempotency-Key: restock/<request UUID>`. Every retry, including after a crash or a lost success response, reuses both unchanged. Product changes do not mutate a queued email.
5. Notification status and timestamp change only after a valid provider acknowledgement. Transient errors retry with capped exponential backoff, jitter, and Retry-After handling. A separate reconciliation schedule covers missed webhooks and requests submitted while already in stock.
6. Permanent email errors are visible as **attention**, with a protected retry action after configuration is corrected. An uncertain delivery older than 23 hours also becomes **attention**, and cannot be blindly retried: real Resend retains idempotency keys for 24 hours. Inspect the provider inbox and reconcile explicitly. Stock outages remain scheduled; they are never recorded as a successful out-of-stock result.

This is durable at-least-once work processing with provider-idempotent email acceptance, **not an unconditional distributed exactly-once guarantee**. It relies on the provider retaining the idempotency key and the SQLite volume remaining intact. Provider acceptance does not prove inbox delivery. A retry waits if stock has sold out; an email that was accepted with a lost response may remain unresolved until stock returns or attention is needed. Stock can also change between a check and a send; an alert is not a reservation.

One container is the intended deployment. SQLite claims protect concurrent worker instances sharing the same local database, but horizontal scaling across independent volumes is not supported. Recipient-level leases intentionally trade a short recovery delay (up to 30 seconds) for safe crash handling. Waiting requests are polled individually, appropriate for this challenge; a larger installation should coalesce stock checks per SKU and add external monitoring/retention policies.

## Deployment and submission

Use a persistent Docker host such as Railway, Render with a persistent disk, or a VPS. Configure all required variables, mount the persistent directory at `/app/data`, set `DATA_DIR=/app/data`, set `PUBLIC_URL` to the real HTTPS origin, and use `/healthz` as the health check. Save that live origin in the client sandbox dashboard, then exercise restocks, duplicate events, phantom events, and injected email failures. Do not use the local demo credentials in the hosted harness.

Render can build the Dockerfile directly from the GitHub repository; Docker does not need to be installed locally. Use paid web-service compute with a persistent disk and one instance. Render Free is not suitable for this SQLite application: it cannot attach a persistent disk, loses filesystem changes on restart/redeploy/spin-down, and suspends the retry worker while idle. A free preview must not be presented as a durable deployment.

See TASKS.md for actual verification and remaining delivery work. A repository URL and durable live URL must be created with the user's accounts; neither should be fabricated. The job posting expects them even though the technical brief calls the live URL optional.

AI tool used for this implementation: **Qoder**, with user-supplied Gemini planning material. Report actual completion time once deployment and final verification are complete; the supplied draft's 35-minute claim is not evidence.
