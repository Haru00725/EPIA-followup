const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DEFAULT_DB = path.join(__dirname, "..", "data", "followups.db");

function openDb(file = process.env.DB_PATH || DEFAULT_DB) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });

    const db = new Database(file);
    db.pragma("journal_mode = WAL");

    db.exec(`
    CREATE TABLE IF NOT EXISTS patients (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      name                  TEXT NOT NULL,
      phone                 TEXT NOT NULL,
      consultation_date     TEXT NOT NULL,
      next_follow_up_date   TEXT NOT NULL,
      follow_up_status      TEXT NOT NULL DEFAULT 'pending'
                            CHECK (follow_up_status IN ('pending','completed')),
      completed_at          TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_patients_due
      ON patients (follow_up_status, next_follow_up_date);
  `);

    return db;
}

module.exports = { openDb };