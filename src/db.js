import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'restock.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      sku TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','queued','retrying','notified','attention')),
      created_at INTEGER NOT NULL,
      notified_at INTEGER,
      next_attempt_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      check_failures INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_until INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT,
      first_attempt_at INTEGER,
      provider_id TEXT,
      last_error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_request ON requests(email, sku) WHERE status <> 'notified';
    CREATE INDEX IF NOT EXISTS due_requests ON requests(next_attempt_at, lease_until) WHERE status IN ('waiting','queued','retrying');
    CREATE INDEX IF NOT EXISTS requests_by_sku ON requests(sku, status);
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      received_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  return {
    db,
    close: () => db.close(),
    subscribe(email, sku, now = Date.now()) {
      return transaction(() => {
        const existing = db.prepare("SELECT id, status FROM requests WHERE email = ? AND sku = ? AND status <> 'notified'").get(email, sku);
        if (existing) return { ...existing, duplicate: true };
        const id = randomUUID();
        db.prepare('INSERT INTO requests(id,email,sku,created_at,next_attempt_at) VALUES(?,?,?,?,?)').run(id, email, sku, now, now);
        return { id, status: 'waiting', duplicate: false };
      });
    },
    acceptEvent(event, now = Date.now()) {
      return transaction(() => {
        const previous = db.prepare('SELECT sku, quantity FROM webhook_events WHERE event_id = ?').get(event.event_id);
        if (previous) return previous.sku === event.sku && previous.quantity === event.quantity ? 'duplicate' : 'conflict';
        db.prepare('INSERT INTO webhook_events(event_id,sku,quantity,received_at) VALUES(?,?,?,?)').run(event.event_id, event.sku, event.quantity, now);
        db.prepare("UPDATE requests SET next_attempt_at = MIN(next_attempt_at, ?) WHERE sku = ? AND status = 'waiting' AND attempts = 0 AND check_failures = 0").run(now, event.sku);
        return 'accepted';
      });
    },
    claim(leaseMs, now = Date.now()) {
      const token = randomUUID();
      return db.prepare(`UPDATE requests SET lease_token = ?, lease_until = ? WHERE id = (
        SELECT id FROM requests WHERE status IN ('waiting','queued','retrying') AND next_attempt_at <= ? AND lease_until <= ?
        ORDER BY next_attempt_at, created_at LIMIT 1
      ) RETURNING *`).get(token, now + leaseMs, now, now);
    },
    updateClaim(row, values) {
      const allowed = new Set(['status','notified_at','next_attempt_at','attempts','check_failures','payload_json','first_attempt_at','provider_id','last_error','lease_until','lease_token']);
      const entries = Object.entries(values);
      if (!entries.length || entries.some(([key]) => !allowed.has(key))) throw new Error('Invalid queue update');
      return db.prepare(`UPDATE requests SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ? AND lease_token = ?`).run(...entries.map(([, value]) => value), row.id, row.lease_token).changes > 0;
    },
    list({ status = '', query = '', page = 1 }) {
      const clauses = [];
      const args = [];
      if (status) { clauses.push('status = ?'); args.push(status); }
      if (query) { clauses.push('(instr(email, ?) > 0 OR instr(lower(sku), ?) > 0)'); args.push(query.toLowerCase(), query.toLowerCase()); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM requests ${where}`).get(...args).n;
      const stats = { total: 0, waiting: 0, queued: 0, retrying: 0, notified: 0, attention: 0 };
      for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM requests GROUP BY status').all()) { stats[row.status] = row.n; stats.total += row.n; }
      const requests = db.prepare(`SELECT id,email,sku,status,created_at,notified_at,attempts,last_error,next_attempt_at FROM requests ${where} ORDER BY created_at DESC, id LIMIT 20 OFFSET ?`).all(...args, (page - 1) * 20);
      for (const row of requests) {
        for (const key of ['created_at', 'notified_at', 'next_attempt_at']) row[key] = row[key] === null ? null : new Date(row[key]).toISOString();
      }
      return { requests, total, page, pageSize: 20, stats };
    },
  };
}
