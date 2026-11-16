// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

//! Local SQLite storage for downloaded file indexes, character looks, and characters.
//!
//! Stores records in `<home_dir>/flow-mcp.db` with `0600` file permissions on Unix.

use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::db_path;
use crate::cookies::{create_private_dir_all, set_private_file_permissions};

/// SQLite DDL creating the `downloads`, `character_looks`, and `characters` tables.
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL,
    project_id TEXT,
    project_title TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    prompt TEXT,
    source_url TEXT,
    file_path TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL,
    asset_created_at TEXT,
    downloaded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_downloads_asset_id ON downloads(asset_id);
CREATE INDEX IF NOT EXISTS idx_downloads_downloaded_at ON downloads(downloaded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_downloads_project_id ON downloads(project_id);

CREATE TABLE IF NOT EXISTS character_looks (
    role TEXT PRIMARY KEY,
    look TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    name TEXT NOT NULL,
    bio TEXT,
    voice TEXT,
    ref_asset_ids TEXT,
    updated_at INTEGER NOT NULL
);
"#;

/// Returns the current Unix epoch time in milliseconds.
pub(crate) fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

/// Creates the SQLite database file and parent directory with owner-only permissions.
fn ensure_private_db_file(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    create_private_dir_all(parent)?;

    let mut opts = OpenOptions::new();
    opts.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
        .with_context(|| format!("Failed to open SQLite database at {}", path.display()))?;
    set_private_file_permissions(path);
    Ok(())
}

/// Opens and initializes `<home_dir>/flow-mcp.db` with WAL pragmas and schema tables.
fn open_initialized_connection() -> Result<Connection> {
    let path = db_path();
    ensure_private_db_file(&path)?;

    let conn = Connection::open(&path)
        .with_context(|| format!("Failed to connect to SQLite database at {}", path.display()))?;
    set_private_file_permissions(&path);
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA foreign_keys = ON;",
    )?;
    conn.execute_batch(SCHEMA_SQL)?;
    Ok(conn)
}

/// Thread-safe handle to `<home_dir>/flow-mcp.db`.
#[derive(Clone, Default)]
pub(crate) struct FlowDb {
    /// Lazily opened SQLite connection guarded by a mutex.
    conn: Arc<Mutex<Option<Connection>>>,
}

impl FlowDb {
    /// Creates a lazy SQLite database handle backed by `<home_dir>/flow-mcp.db`.
    pub(crate) fn new() -> Self {
        Self {
            conn: Arc::new(Mutex::new(None)),
        }
    }

    /// Acquires the SQLite connection lock, opens the database if needed, and runs `op`.
    fn with_conn<F, R>(&self, op: F) -> Result<R>
    where
        F: FnOnce(&mut Connection) -> Result<R>,
    {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| anyhow::anyhow!("SQLite database mutex poisoned"))?;
        let conn = match guard.as_mut() {
            Some(c) => c,
            None => guard.insert(open_initialized_connection()?),
        };
        op(conn)
    }

    /// Executes `op` on a blocking thread with exclusive access to the SQLite connection.
    async fn run_blocking<F, R>(&self, op: F) -> Result<R>
    where
        F: FnOnce(&mut Connection) -> Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let db = self.clone();
        tokio::task::spawn_blocking(move || db.with_conn(op))
            .await
            .map_err(|e| anyhow::anyhow!("SQLite worker task failed: {}", e))?
    }

    /// Returns the total number of indexed download rows.
    pub(crate) async fn count_downloads(&self) -> Result<usize> {
        self.run_blocking(|conn| {
            let count: i64 =
                conn.query_row("SELECT COUNT(*) FROM downloads", [], |row| row.get(0))?;
            Ok(count.max(0) as usize)
        })
        .await
    }

    /// Loads all saved `role` to `look` entries from `character_looks`.
    pub(crate) async fn load_character_looks(&self) -> Result<HashMap<String, String>> {
        self.run_blocking(|conn| {
            let mut stmt = conn.prepare("SELECT role, look FROM character_looks ORDER BY role")?;
            let rows = stmt.query_map([], |row| {
                let role: String = row.get(0)?;
                let look: String = row.get(1)?;
                Ok((role, look))
            })?;
            let mut looks = HashMap::new();
            for row in rows {
                let (role, look) = row?;
                looks.insert(role, look);
            }
            Ok(looks)
        })
        .await
    }

    /// Deletes all stored character records that belong to `project_id`.
    pub(crate) async fn delete_characters_by_project(&self, project_id: &str) -> Result<usize> {
        let project_id = project_id.to_string();
        self.run_blocking(move |conn| {
            let n = conn.execute(
                "DELETE FROM characters WHERE project_id = ?1",
                params![project_id],
            )?;
            Ok(n)
        })
        .await
    }
}
