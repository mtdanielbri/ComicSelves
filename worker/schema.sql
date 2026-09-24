-- Collection: one row per book (Spanish/English tomo) or Comic Vine issue.
-- id: 'isbn:<13 digits>' | 'gb:<google id>' | 'cv-issue:<id>' | 'manual:<uuid>'
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- 'book' | 'issue'
  title TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}', -- JSON: isbn, publisher, year, cover, authors, contains[], volume...
  owned INTEGER NOT NULL DEFAULT 0,
  read INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Response cache for external APIs (Comic Vine allows ~200 requests/hour per resource).
CREATE TABLE IF NOT EXISTS cache (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  exp INTEGER NOT NULL
);
