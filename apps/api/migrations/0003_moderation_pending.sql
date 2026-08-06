-- Adds a 'pending' verdict, so an image that could not be screened at upload time is recorded as
-- unscreened rather than silently absent.
--
-- Uploads fail *open*: an organizer at a live event whose art is refused because a third-party
-- API is down is stuck, with no workaround and a room waiting. The image is stored and served,
-- and a sweep scores it shortly afterwards — deleting it from R2 and recording a reject if it
-- turns out to be unacceptable.
--
-- What makes that safe rather than merely permissive is that this row exists. Without it there is
-- no record that anything went unchecked, and "fail open" quietly becomes "never checked".
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt. It is small and this
-- runs once.

CREATE TABLE image_moderation_new (
    sha256      TEXT PRIMARY KEY,
    verdict     TEXT NOT NULL CHECK (verdict IN ('allow', 'reject', 'pending')),

    adult       INTEGER NOT NULL DEFAULT 0,
    racy        INTEGER NOT NULL DEFAULT 0,
    violence    INTEGER NOT NULL DEFAULT 0,
    medical     INTEGER NOT NULL DEFAULT 0,
    spoof       INTEGER NOT NULL DEFAULT 0,

    -- Needed to delete the object if the sweep later refuses it. Derivable from the digest and
    -- content type, but storing it means the sweep never has to reproduce that logic.
    object_key  TEXT,
    -- Bounded retries, so one permanently undecodable image cannot occupy the queue forever.
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,

    submitted_by TEXT,
    checked_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

INSERT INTO image_moderation_new
    (sha256, verdict, adult, racy, violence, medical, spoof, submitted_by, checked_at)
SELECT sha256, verdict, adult, racy, violence, medical, spoof, submitted_by, checked_at
FROM image_moderation;

DROP TABLE image_moderation;
ALTER TABLE image_moderation_new RENAME TO image_moderation;

CREATE INDEX image_moderation_by_submitter ON image_moderation (submitted_by, verdict, checked_at);

-- The sweep's read path: oldest unscreened first, fewest attempts first.
CREATE INDEX image_moderation_pending ON image_moderation (verdict, attempts, checked_at)
    WHERE verdict = 'pending';
