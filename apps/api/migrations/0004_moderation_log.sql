-- An append-only record of every screening attempt.
--
-- `image_moderation` holds current state and overwrites on retry: after five failed attempts its
-- `last_error` shows only the fifth. That is the wrong shape for the question actually asked of
-- it later — "what happened to this image, and when" — because the interesting part is usually
-- the pattern across attempts rather than the final one.
--
-- Written for refusals and for failures to screen. Both matter: a refusal is a decision someone
-- may have to justify, and a failure is the reason an image was served unscreened.

CREATE TABLE moderation_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256       TEXT NOT NULL,
    object_key   TEXT,

    -- 'allow' and 'reject' are decisions from Vision. 'error' is a failure to reach or parse it,
    -- which is what causes an image to be admitted unscreened.
    outcome      TEXT NOT NULL CHECK (outcome IN ('allow', 'reject', 'error')),
    -- 'upload' for the inline check, 'sweep' for the batch retry, so the two are distinguishable.
    source       TEXT NOT NULL CHECK (source IN ('upload', 'sweep')),
    attempt      INTEGER NOT NULL DEFAULT 0,

    -- The SafeSearch likelihoods as returned, 0..5. Null on an 'error' row, where there are none.
    adult        INTEGER,
    racy         INTEGER,
    violence     INTEGER,
    medical      INTEGER,
    spoof        INTEGER,
    -- Which categories crossed their thresholds, comma-separated. Empty for an allow.
    reasons      TEXT,
    -- Verbatim failure text on an 'error' row.
    error        TEXT,

    submitted_by TEXT,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- The history of one image, newest first.
CREATE INDEX moderation_events_by_image ON moderation_events (sha256, created_at DESC);

-- "What has been refused lately", and "is screening failing right now".
CREATE INDEX moderation_events_by_outcome ON moderation_events (outcome, created_at DESC);
