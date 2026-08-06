-- Lets a human decision be recorded alongside the automated ones.
--
-- `moderation_events.source` allowed only 'upload' and 'sweep'. A person resolving an image the
-- sweep gave up on is a third source, and it matters that it is distinguishable: an automated
-- verdict is reproducible from the scores, a human one is not, and "who decided this" is the
-- first question anyone asks about a refusal months later.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.

CREATE TABLE moderation_events_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256       TEXT NOT NULL,
    object_key   TEXT,

    outcome      TEXT NOT NULL CHECK (outcome IN ('allow', 'reject', 'error')),
    source       TEXT NOT NULL CHECK (source IN ('upload', 'sweep', 'review')),
    attempt      INTEGER NOT NULL DEFAULT 0,

    adult        INTEGER,
    racy         INTEGER,
    violence     INTEGER,
    medical      INTEGER,
    spoof        INTEGER,
    reasons      TEXT,
    error        TEXT,

    -- Who decided, when a person did. Null for automated rows, where the scores are the reason.
    reviewed_by  TEXT,

    submitted_by TEXT,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

INSERT INTO moderation_events_new
    (id, sha256, object_key, outcome, source, attempt, adult, racy, violence, medical, spoof,
     reasons, error, submitted_by, created_at)
SELECT id, sha256, object_key, outcome, source, attempt, adult, racy, violence, medical, spoof,
       reasons, error, submitted_by, created_at
FROM moderation_events;

DROP TABLE moderation_events;
ALTER TABLE moderation_events_new RENAME TO moderation_events;

CREATE INDEX moderation_events_by_image ON moderation_events (sha256, created_at DESC);
CREATE INDEX moderation_events_by_outcome ON moderation_events (outcome, created_at DESC);
