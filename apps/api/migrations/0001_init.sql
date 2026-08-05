-- stampd control plane schema.
--
-- Everything here is policy, not settlement. The badge itself lives on Base; these tables
-- decide who is allowed to get one, and they are meant to be rewritable without touching
-- the contract. Nothing in this file is load-bearing for a badge that has already minted.
--
-- Conventions:
--   * addresses are stored lowercase 0x-prefixed, so joins never depend on checksum casing
--   * timestamps are unix seconds (INTEGER), matching the contract's uint64 windows
--   * `strftime('%s','now')` is used for defaults so a row is never written without one

PRAGMA foreign_keys = ON;

-- Organizers are identified by wallet address alone. There is no password, no session, and
-- no email: every mutating dashboard request is signed, the same way uploads already are.
CREATE TABLE organizers (
    address    TEXT PRIMARY KEY,
    display_name TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- An event exists here before it exists on-chain: the organizer fills in the draft, uploads
-- art, and only then pays for `createEvent`. `onchain_event_id` stays NULL until that
-- transaction confirms, which is also how the dashboard knows to show "not yet published".
CREATE TABLE events (
    id                TEXT PRIMARY KEY,          -- uuid, minted by the Worker
    organizer_address TEXT NOT NULL REFERENCES organizers(address) ON DELETE RESTRICT,
    chain_id          INTEGER NOT NULL,
    onchain_event_id  INTEGER,                   -- == tokenId once createEvent lands
    name              TEXT NOT NULL,
    metadata_uri      TEXT,                      -- r2:// or ipfs:// once frozen
    signer_address    TEXT NOT NULL,             -- mirrors EventData.signer
    max_supply        INTEGER NOT NULL DEFAULT 0,-- 0 = unlimited, same sentinel as the contract
    starts_at         INTEGER,
    ends_at           INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- A tokenId is unique per chain, but only once it exists. Partial index so any number of
-- unpublished drafts can coexist.
CREATE UNIQUE INDEX events_onchain_identity
    ON events (chain_id, onchain_event_id)
    WHERE onchain_event_id IS NOT NULL;

CREATE INDEX events_by_organizer ON events (organizer_address, created_at DESC);

-- Only the SHA-256 of a code is stored. A dump of this table therefore yields nothing
-- redeemable: the raw code exists in the QR image and nowhere else, so losing the database
-- costs an event its codes rather than handing an attacker working ones.
--
-- This table holds the one-time static codes only. Rotating codes (~30s windows) are
-- derived inside a Durable Object and never round-trip through D1 — at projector cadence
-- the write rate would dominate everything else in here.
CREATE TABLE claim_codes (
    code_hash   TEXT PRIMARY KEY,
    event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    expires_at  INTEGER,
    redeemed_at INTEGER,
    redeemed_by TEXT
);

-- Supports both "how many codes are left for this event" and the redemption check itself.
CREATE INDEX claim_codes_by_event ON claim_codes (event_id, redeemed_at);

-- One badge per address per event. The primary key *is* the anti-double-badge rule: the
-- contract enforces it too, but enforcing it here means a duplicate costs a failed INSERT
-- instead of a wasted mint slot in a batch.
CREATE TABLE claims (
    event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    address    TEXT NOT NULL,
    code_hash  TEXT REFERENCES claim_codes(code_hash) ON DELETE SET NULL,
    status     TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'submitted', 'minted', 'failed')),
    tx_hash    TEXT,
    error      TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (event_id, address)
);

-- The batch flusher's read path: oldest queued claims first, per event.
CREATE INDEX claims_pending ON claims (event_id, status, created_at)
    WHERE status IN ('queued', 'submitted');

-- Lets the dashboard's CSV export stream in mint order without a sort.
CREATE INDEX claims_by_event ON claims (event_id, created_at);

-- Coarse abuse control: a fixed-window counter keyed by whatever the endpoint decides to
-- bucket on (ip:<addr>:<event>, addr:<addr>, …). Deliberately not the per-request hot path
-- limiter — D1 writes are too slow for that, and the Durable Object already serialises the
-- rotating-code path. This exists so a code-guessing burst leaves a durable trace that
-- survives eviction and shows up in the organizer's view.
CREATE TABLE rate_limits (
    bucket       TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0
);

-- Expired windows are swept, not read; index the sweep rather than the lookup, which the
-- primary key already covers.
CREATE INDEX rate_limits_sweep ON rate_limits (window_start);
