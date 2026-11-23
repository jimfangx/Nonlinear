//! Local SQLite store (design §9 Desktop): WAL mode, durable immediately.
//! Mirrors the web app's IndexedDB stores: records, blobs, outbox.
//! Secrets are NOT stored here (OS keychain instead).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Serialize, Deserialize)]
pub struct Record {
    pub collection: String,
    pub id: String,
    pub value: serde_json::Value,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS records (
                 collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
                 PRIMARY KEY (collection, id));
             CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS outbox (op_id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::open(Path::new(":memory:"))
    }

    pub fn load_all(&self) -> rusqlite::Result<Vec<Record>> {
        let c = self.conn.lock().unwrap();
        let mut st = c.prepare("SELECT collection, id, value, updated_at FROM records")?;
        let rows = st.query_map([], |r| {
            let v: String = r.get(2)?;
            Ok(Record { collection: r.get(0)?, id: r.get(1)?, value: serde_json::from_str(&v).unwrap_or(serde_json::Value::Null), updated_at: r.get(3)? })
        })?;
        rows.collect()
    }

    pub fn put(&self, collection: &str, id: &str, value: &serde_json::Value, now: i64) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO records (collection, id, value, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(collection, id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![collection, id, value.to_string(), now],
        )?;
        Ok(())
    }

    pub fn restore(&self, records: &[Record], blobs: &[(String, String)]) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for record in records {
            tx.execute(
                "INSERT OR REPLACE INTO records (collection, id, value, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![record.collection, record.id, record.value.to_string(), record.updated_at],
            )?;
        }
        for (key, value) in blobs {
            tx.execute("INSERT OR REPLACE INTO blobs (key, value) VALUES (?1, ?2)", params![key, value])?;
        }
        tx.commit()
    }

    pub fn delete(&self, collection: &str, id: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute("DELETE FROM records WHERE collection = ?1 AND id = ?2", params![collection, id])?;
        Ok(())
    }

    pub fn blob_put(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute("INSERT OR REPLACE INTO blobs (key, value) VALUES (?1, ?2)", params![key, value])?;
        Ok(())
    }

    pub fn blob_get(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn.lock().unwrap().query_row("SELECT value FROM blobs WHERE key = ?1", params![key], |r| r.get(0)).optional()
    }

    pub fn blob_delete(&self, key: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute("DELETE FROM blobs WHERE key = ?1", params![key])?;
        Ok(())
    }

    pub fn outbox_add(&self, op_id: &str, value: &serde_json::Value, now: i64) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute("INSERT OR REPLACE INTO outbox (op_id, value, created_at) VALUES (?1, ?2, ?3)", params![op_id, value.to_string(), now])?;
        Ok(())
    }

    pub fn outbox_all(&self) -> rusqlite::Result<Vec<serde_json::Value>> {
        let c = self.conn.lock().unwrap();
        let mut st = c.prepare("SELECT value FROM outbox ORDER BY created_at")?;
        let rows = st.query_map([], |r| {
            let v: String = r.get(0)?;
            Ok(serde_json::from_str(&v).unwrap_or(serde_json::Value::Null))
        })?;
        rows.collect()
    }

    pub fn outbox_remove(&self, ids: &[String]) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        for id in ids {
            c.execute("DELETE FROM outbox WHERE op_id = ?1", params![id])?;
        }
        Ok(())
    }

    pub fn wipe(&self) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute_batch("DELETE FROM records; DELETE FROM blobs; DELETE FROM outbox;")
    }

    /// Delete everything and give the space back to the OS (VACUUM + truncate the WAL).
    pub fn wipe_and_compact(&self) -> rusqlite::Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute_batch("DELETE FROM records; DELETE FROM blobs; DELETE FROM outbox;")?;
        c.execute_batch("VACUUM;")?;
        c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip() {
        let s = Store::in_memory().unwrap();
        s.put("cards", "c1", &serde_json::json!({"title": "x"}), 1).unwrap();
        s.put("cards", "c1", &serde_json::json!({"title": "y"}), 2).unwrap();
        let all = s.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].value["title"], "y");
        s.blob_put("k", "v").unwrap();
        assert_eq!(s.blob_get("k").unwrap().as_deref(), Some("v"));
        s.outbox_add("op1", &serde_json::json!({"opId": "op1"}), 1).unwrap();
        assert_eq!(s.outbox_all().unwrap().len(), 1);
        s.outbox_remove(&["op1".into()]).unwrap();
        assert!(s.outbox_all().unwrap().is_empty());
        s.delete("cards", "c1").unwrap();
        assert!(s.load_all().unwrap().is_empty());
    }
}
