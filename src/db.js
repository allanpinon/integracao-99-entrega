const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

let db;

function open(file) {
  const target = file || path.join(config.dataDir, 'integracao.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  db = new DatabaseSync(target);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS installs (
      merchant_id    INTEGER PRIMARY KEY,
      name           TEXT,
      access_token   TEXT NOT NULL,
      refresh_token  TEXT,
      expires_at     INTEGER NOT NULL,
      driver99_id    INTEGER,
      active         INTEGER NOT NULL DEFAULT 1,
      updated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state       TEXT PRIMARY KEY,
      verifier    TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_id      INTEGER NOT NULL,
      cw_order_id      INTEGER NOT NULL,
      display_id       INTEGER,
      attempt          INTEGER NOT NULL,
      external_id      TEXT NOT NULL UNIQUE,
      n99_order_id     TEXT,
      status           TEXT NOT NULL,
      n99_status       TEXT,
      quoted_fee_cents INTEGER,
      final_fee_cents  INTEGER,
      cw_delivery_fee  REAL,
      distance_m       INTEGER,
      error            TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_order ON jobs (merchant_id, cw_order_id);
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status);

    CREATE TABLE IF NOT EXISTS seen_events (
      event_id   TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);
  // Migrações simples (colunas novas)
  for (const sql of [
    `ALTER TABLE installs ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'oauth'`,
    `ALTER TABLE jobs ADD COLUMN rearm INTEGER NOT NULL DEFAULT 0`,
  ]) {
    try { db.exec(sql); } catch { /* coluna já existe */ }
  }
  return db;
}

function get() {
  if (!db) open();
  return db;
}

const now = () => Date.now();

// Status internos do job
const ACTIVE = ['creating', 'finding', 'waiting', 'delivering', 'sendback'];

const installs = {
  upsert(i) {
    get().prepare(`
      INSERT INTO installs (merchant_id, name, access_token, refresh_token, expires_at, driver99_id, active, auth_mode, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'oauth', ?)
      ON CONFLICT(merchant_id) DO UPDATE SET
        name = excluded.name,
        auth_mode = 'oauth',
        access_token = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token, installs.refresh_token),
        expires_at = excluded.expires_at,
        driver99_id = COALESCE(excluded.driver99_id, installs.driver99_id),
        active = 1,
        updated_at = excluded.updated_at
    `).run(i.merchant_id, i.name ?? null, i.access_token, i.refresh_token ?? null,
      i.expires_at, i.driver99_id ?? null, now());
  },
  upsertLegacy({ merchant_id, driver99_id }) {
    get().prepare(`
      INSERT INTO installs (merchant_id, name, access_token, refresh_token, expires_at, driver99_id, active, auth_mode, updated_at)
      VALUES (?, ?, '', NULL, 0, ?, 1, 'legacy', ?)
      ON CONFLICT(merchant_id) DO UPDATE SET
        driver99_id = COALESCE(excluded.driver99_id, installs.driver99_id),
        active = 1,
        auth_mode = CASE WHEN installs.access_token = '' THEN 'legacy' ELSE installs.auth_mode END,
        updated_at = excluded.updated_at
    `).run(merchant_id, `Loja ${merchant_id}`, driver99_id ?? null, now());
  },
  setName(merchantId, name) {
    get().prepare(`UPDATE installs SET name=? WHERE merchant_id=?`).run(name, merchantId);
  },
  updateTokens(merchantId, t) {
    get().prepare(`UPDATE installs SET access_token=?, refresh_token=COALESCE(?, refresh_token), expires_at=?, updated_at=? WHERE merchant_id=?`)
      .run(t.access_token, t.refresh_token ?? null, t.expires_at, now(), merchantId);
  },
  setDriver(merchantId, driverId) {
    get().prepare(`UPDATE installs SET driver99_id=?, updated_at=? WHERE merchant_id=?`).run(driverId, now(), merchantId);
  },
  deactivate(merchantId) {
    get().prepare(`UPDATE installs SET active=0, updated_at=? WHERE merchant_id=?`).run(now(), merchantId);
  },
  all() { return get().prepare(`SELECT * FROM installs WHERE active=1`).all(); },
  byId(id) { return get().prepare(`SELECT * FROM installs WHERE merchant_id=?`).get(id); },
};

const states = {
  put(state, verifier) {
    get().prepare(`INSERT INTO oauth_states (state, verifier, created_at) VALUES (?, ?, ?)`).run(state, verifier, now());
  },
  take(state) {
    const row = get().prepare(`SELECT * FROM oauth_states WHERE state=?`).get(state);
    if (!row) return null;
    get().prepare(`DELETE FROM oauth_states WHERE state=?`).run(state);
    if (now() - row.created_at > 30 * 60 * 1000) return null; // expira em 30 min
    return row;
  },
};

const jobs = {
  create(j) {
    const info = get().prepare(`
      INSERT INTO jobs (merchant_id, cw_order_id, display_id, attempt, external_id, status, cw_delivery_fee, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'creating', ?, ?, ?)
    `).run(j.merchant_id, j.cw_order_id, j.display_id ?? null, j.attempt, j.external_id, j.cw_delivery_fee ?? null, now(), now());
    return jobs.byId(Number(info.lastInsertRowid));
  },
  update(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k}=?`).join(', ');
    get().prepare(`UPDATE jobs SET ${sets}, updated_at=? WHERE id=?`)
      .run(...keys.map((k) => fields[k] ?? null), now(), id);
  },
  byId(id) { return get().prepare(`SELECT * FROM jobs WHERE id=?`).get(id); },
  byExternal(ext) { return get().prepare(`SELECT * FROM jobs WHERE external_id=?`).get(ext); },
  byN99(orderId) { return get().prepare(`SELECT * FROM jobs WHERE n99_order_id=?`).get(orderId); },
  latestForOrder(merchantId, cwOrderId) {
    return get().prepare(`SELECT * FROM jobs WHERE merchant_id=? AND cw_order_id=? ORDER BY attempt DESC LIMIT 1`)
      .get(merchantId, cwOrderId);
  },
  active() {
    return get().prepare(`SELECT * FROM jobs WHERE status IN (${ACTIVE.map(() => '?').join(',')})`).all(...ACTIVE);
  },
  recent(limit = 100) { return get().prepare(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`).all(limit); },
};

const events = {
  // true se o evento é novo
  markSeen(eventId) {
    try {
      get().prepare(`INSERT INTO seen_events (event_id, created_at) VALUES (?, ?)`).run(eventId, now());
      return true;
    } catch { return false; }
  },
  prune(olderThanMs = 7 * 24 * 3600 * 1000) {
    get().prepare(`DELETE FROM seen_events WHERE created_at < ?`).run(now() - olderThanMs);
  },
};

module.exports = { open, get, installs, states, jobs, events, ACTIVE };
