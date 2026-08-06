-- Moderation verdicts, keyed by the SHA-256 of the image bytes.
--
-- Object keys are already content-addressed, so identical bytes are the same upload no matter who
-- sends them or when. That makes a verdict cacheable forever: re-uploading the same image cannot
-- change what is in it. Without this, a popular badge image would be re-scored on every event and
-- billed every time.
--
-- It also closes a cheap abuse path — resubmitting a rejected image to burn moderation quota — by
-- answering from the table rather than the vendor.

CREATE TABLE image_moderation (
    sha256      TEXT PRIMARY KEY,
    -- 'allow' or 'reject'. Stored rather than recomputed from the scores below, so that changing
    -- the thresholds later does not silently re-admit an image that was already refused.
    verdict     TEXT NOT NULL CHECK (verdict IN ('allow', 'reject')),

    -- Google's five-point likelihood scale, flattened to 0..5 (UNKNOWN..VERY_LIKELY). Kept even
    -- for allowed images: without the scores there is no way to audit a threshold change, or to
    -- answer "why was this refused" three months later.
    adult       INTEGER NOT NULL DEFAULT 0,
    racy        INTEGER NOT NULL DEFAULT 0,
    violence    INTEGER NOT NULL DEFAULT 0,
    medical     INTEGER NOT NULL DEFAULT 0,
    spoof       INTEGER NOT NULL DEFAULT 0,

    -- Which address submitted it. A single wallet accumulating rejections is the signal worth
    -- acting on; one rejection on its own is usually an accident.
    submitted_by TEXT,
    checked_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Supports "has this wallet been refused before, and how often".
CREATE INDEX image_moderation_by_submitter ON image_moderation (submitted_by, verdict, checked_at);
