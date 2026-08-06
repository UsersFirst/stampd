/// stampd control plane.
///
/// Deployed to *.workers.dev rather than a route on stampd.usersfirst.com, because that
/// zone's DNS lives at name.com and Worker routes only fire for zones Cloudflare hosts.
/// The API is therefore cross-origin to the dashboard and speaks CORS. Preflights are
/// cached for a day, so the cost is one extra round trip per browser session.
///
/// Today this handles badge art and metadata. Phase 3 adds D1-backed claim codes and
/// EIP-712 voucher signing alongside it.

import {createPublicClient, http, recoverMessageAddress, isAddress} from "viem";
import {classifyImage, describeScore, thresholdsFrom, type SafeSearchScores} from "./moderation";
import {base, baseSepolia} from "viem/chains";
import {
    UPLOAD_AUTH_WINDOW_SECONDS,
    UPLOAD_HEADERS,
    buildUploadAuthMessage,
    sha256Hex,
    type Address,
} from "@stampd/shared";

export interface Env {
    ASSETS_BUCKET: R2Bucket;
    /// Claim codes, claims, and event drafts. Schema in migrations/.
    DB: D1Database;
    /// Comma-separated origins permitted to call this API from a browser.
    ALLOWED_ORIGINS: string;
    /// RPC endpoints per chain, consulted to verify smart-contract-wallet signatures. A signer
    /// may legitimately be on either chain, and which one is not ours to choose — see below.
    RPC_URL_BASE_SEPOLIA: string;
    RPC_URL_BASE: string;
    /// Google Cloud Vision key, set with `wrangler secret put GOOGLE_VISION_API_KEY`. When absent
    /// moderation is skipped rather than failing every upload, so the Worker can be deployed
    /// before the key exists — `/api/health` reports which state it is in.
    GOOGLE_VISION_API_KEY?: string;
    MODERATION_THRESHOLD_ADULT?: string;
    MODERATION_THRESHOLD_RACY?: string;
    MODERATION_THRESHOLD_VIOLENCE?: string;
}

/// Chains a signature may be produced on. Anything else is rejected rather than guessed at:
/// picking a chain for the caller is what produced the "Invalid signature" that was really
/// "verified against the wrong network".
const VERIFY_CHAINS = {
    [base.id]: base,
    [baseSepolia.id]: baseSepolia,
} as const;

function rpcUrlFor(chainId: number, env: Env): string {
    return chainId === base.id ? env.RPC_URL_BASE : env.RPC_URL_BASE_SEPOLIA;
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/// SVG is deliberately absent. It is an active document format: an uploaded
/// <svg><script> would execute in whatever origin serves it. The headers on asset
/// responses are a second layer, not a licence to re-add it.
const ALLOWED_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/json"]);

const EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "application/json": "json",
};

function allowedOrigin(request: Request, env: Env): string | null {
    const origin = request.headers.get("origin");
    if (!origin) return null;
    const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
    return allowed.includes(origin) ? origin : null;
}

/// Applied to every response. `Vary: Origin` is required or a cache could serve one
/// origin's allow header to another.
function withCors(response: Response, request: Request, env: Env): Response {
    const headers = new Headers(response.headers);
    headers.append("vary", "Origin");
    const origin = allowedOrigin(request, env);
    if (origin) headers.set("access-control-allow-origin", origin);
    return new Response(response.body, {status: response.status, headers});
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {"content-type": "application/json; charset=utf-8"},
    });
}

/// Returns only the preflight-specific headers. `access-control-allow-origin` and `Vary`
/// come from `withCors`, which every response goes through — including this one. A preflight
/// answered without an allow-origin header is a failed preflight, so keeping the two in one
/// place is what stops them drifting apart.
function handlePreflight(request: Request, env: Env): Response {
    if (!allowedOrigin(request, env)) return new Response(null, {status: 403});
    return new Response(null, {
        status: 204,
        headers: {
            "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
            "access-control-allow-headers": ["content-type", ...Object.values(UPLOAD_HEADERS)].join(", "),
            "access-control-max-age": "86400",
        },
    });
}

/// Verifies the wallet signature over (address, body hash, timestamp). Returns an error
/// Response when the request should be rejected, or null when it is authorized.
async function checkUploadAuth(request: Request, env: Env, digest: string): Promise<Response | null> {
    const address = request.headers.get(UPLOAD_HEADERS.address);
    const issued = request.headers.get(UPLOAD_HEADERS.issued);
    const signature = request.headers.get(UPLOAD_HEADERS.signature);
    const chain = request.headers.get(UPLOAD_HEADERS.chain);

    if (!address || !issued || !signature || !chain) return json({error: "Missing upload authorization."}, 401);
    if (!isAddress(address)) return json({error: "Malformed address."}, 401);
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) return json({error: "Malformed signature."}, 401);

    const issuedAt = Number(issued);
    if (!Number.isInteger(issuedAt)) return json({error: "Malformed timestamp."}, 401);

    const chainId = Number(chain);
    const verifyChain = VERIFY_CHAINS[chainId as keyof typeof VERIFY_CHAINS];
    if (!verifyChain) return json({error: `Unsupported chain: ${chain}.`}, 400);

    const skew = Math.abs(Math.floor(Date.now() / 1000) - issuedAt);
    if (skew > UPLOAD_AUTH_WINDOW_SECONDS) {
        return json({error: "Authorization expired; sign again."}, 401);
    }

    // The chain id is inside the signed message, so a caller cannot claim to have signed on one
    // chain while having signed on another — the message would not match and recovery would fail.
    const message = buildUploadAuthMessage({address: address as Address, sha256: digest, issuedAt, chainId});

    // Plain EOA signatures verify offline. Smart-contract wallets (ERC-1271/6492) need
    // chain state, so only those pay for an RPC round-trip.
    try {
        const recovered = await recoverMessageAddress({message, signature: signature as `0x${string}`});
        if (recovered.toLowerCase() === address.toLowerCase()) return null;
    } catch {
        // fall through to on-chain verification
    }

    const client = createPublicClient({chain: verifyChain, transport: http(rpcUrlFor(chainId, env))});

    try {
        const valid = await client.verifyMessage({
            address: address as Address,
            message,
            signature: signature as `0x${string}`,
        });
        if (valid) return null;
    } catch {
        return json({error: "Could not verify signature."}, 503);
    }

    // A smart-contract wallet with no code on the chain it claims to have signed on is the
    // common, recoverable case, and "Invalid signature" sends people looking in the wrong place.
    // Name it, because the fix is to switch networks and sign again.
    try {
        const code = await client.getCode({address: address as Address});
        if (!code || code === "0x") {
            return json(
                {
                    error:
                        `No wallet contract at this address on ${verifyChain.name}, and the signature is not ` +
                        `a plain wallet signature. If you signed with a smart wallet on another network, ` +
                        `switch to ${verifyChain.name} and sign again.`,
                },
                401,
            );
        }
    } catch {
        // The verification result stands on its own; this lookup only improves the message.
    }

    return json({error: "Invalid signature."}, 401);
}

/// Screens an image before it is stored.
///
/// Fails *open*. If the moderator cannot be reached the image is stored and served, and marked
/// `pending` for the sweep to score shortly afterwards. An organizer at a live event whose art is
/// refused because a third-party API is down is stuck, with no workaround and a room waiting;
/// that is a worse failure than a short window in which an unscreened image is reachable by
/// whoever holds its URL.
///
/// What makes that safe rather than merely permissive is the `pending` row. Without a record that
/// something went unchecked, "fail open" quietly becomes "never checked".
///
/// @returns `refusal` to reject the upload outright, and `pending` when it was admitted unscored
///          and the caller must record it for the sweep.
async function moderate(
    bytes: ArrayBuffer,
    digest: string,
    submittedBy: string | null,
    contentType: string,
    env: Env,
): Promise<{refusal: Response | null; pending: boolean}> {
    // Metadata JSON has no pixels to look at, and its fields are already bounded by the schema.
    if (contentType === "application/json") return {refusal: null, pending: false};

    // Checked before the key, deliberately. Content-addressed keys make a verdict permanent —
    // identical bytes are the same image forever — so an image already judged unacceptable stays
    // refused even if screening is later switched off. It also stops a rejected image being
    // resubmitted to burn moderation quota.
    try {
        const cached = await env.DB.prepare("SELECT verdict FROM image_moderation WHERE sha256 = ?")
            .bind(digest)
            .first<{verdict: string}>();
        if (cached?.verdict === "reject") return {refusal: json({error: REFUSAL_MESSAGE}, 422), pending: false};
        if (cached?.verdict === "allow") return {refusal: null, pending: false};
        // A row already 'pending' is re-queued rather than re-scored inline: the sweep owns it.
        if (cached?.verdict === "pending") return {refusal: null, pending: true};
    } catch {
        // A cache miss must never be the reason an upload fails; fall through and ask the vendor.
    }

    // Not configured is not the same as unscreened. Leaving no row means the sweep will not chase
    // an image nobody ever intended to screen.
    if (!env.GOOGLE_VISION_API_KEY) return {refusal: null, pending: false};

    let result;
    try {
        result = await classifyImage(bytes, env.GOOGLE_VISION_API_KEY, thresholdsFrom(env));
    } catch (error) {
        // Fail open, but on the record. The upload proceeds and the sweep scores it shortly. This
        // row is the reason an unscreened image was served, so it is worth more than a log line.
        await logModeration(env, {
            sha256: digest,
            outcome: "error",
            source: "upload",
            error: error instanceof Error ? error.message : String(error),
            submittedBy,
        });
        return {refusal: null, pending: true};
    }

    try {
        await env.DB.prepare(
            `INSERT INTO image_moderation (sha256, verdict, adult, racy, violence, medical, spoof, submitted_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(sha256) DO UPDATE SET
                 verdict = excluded.verdict, adult = excluded.adult, racy = excluded.racy,
                 violence = excluded.violence, medical = excluded.medical, spoof = excluded.spoof,
                 checked_at = strftime('%s', 'now')`,
        )
            .bind(
                digest,
                result.verdict,
                result.scores.adult,
                result.scores.racy,
                result.scores.violence,
                result.scores.medical,
                result.scores.spoof,
                submittedBy?.toLowerCase() ?? null,
            )
            .run();
    } catch {
        // Recording the verdict is bookkeeping. Failing to write it must not change the decision.
    }

    await logModeration(env, {
        sha256: digest,
        outcome: result.verdict,
        source: "upload",
        scores: result.scores,
        reasons: result.reasons,
        submittedBy,
    });

    if (result.verdict === "reject") return {refusal: json({error: REFUSAL_MESSAGE}, 422), pending: false};

    return {refusal: null, pending: false};
}

/// Scores everything admitted unscored, deletes what it refuses, and is the half of "fail open"
/// that makes it defensible. Driven by the cron trigger.
///
/// Retries are bounded. An image that fails `MAX_MODERATION_ATTEMPTS` times stops being retried
/// and stays pending, where the health endpoint reports it as awaiting review — a person then
/// looks at it and decides. Retrying forever would hide a persistent failure behind a queue that
/// never drains; giving up silently would leave an unscreened image served with nobody told.
///
/// @returns counts, so an operator can see it did something.
export async function sweepPending(env: Env, limit = 25): Promise<{scanned: number; rejected: number}> {
    if (!env.GOOGLE_VISION_API_KEY) return {scanned: 0, rejected: 0};

    // Ceiling interpolated for the same reason as in the health query — bound, it let an image
    // past its retry limit, which is how a permanently failing image would be retried forever.
    const pending = await env.DB.prepare(
        `SELECT sha256, object_key, attempts FROM image_moderation
         WHERE verdict = 'pending' AND attempts < ${MAX_MODERATION_ATTEMPTS}
         ORDER BY attempts ASC, checked_at ASC LIMIT ?`,
    )
        .bind(limit)
        .all<{sha256: string; object_key: string | null; attempts: number}>();

    let rejected = 0;
    let scanned = 0;

    for (const row of pending.results ?? []) {
        if (!row.object_key) continue;

        const object = await env.ASSETS_BUCKET.get(row.object_key);
        if (!object) {
            // Already gone. Nothing left to screen, and leaving it pending would retry forever.
            await env.DB.prepare("UPDATE image_moderation SET verdict = 'allow', last_error = 'object missing' WHERE sha256 = ?")
                .bind(row.sha256)
                .run();
            continue;
        }

        try {
            const result = await classifyImage(
                await object.arrayBuffer(),
                env.GOOGLE_VISION_API_KEY,
                thresholdsFrom(env),
            );
            scanned += 1;

            // Delete before recording, so a failure between the two leaves the row pending and
            // the object gone rather than the row clean and the object still served.
            if (result.verdict === "reject") {
                await env.ASSETS_BUCKET.delete(row.object_key);
                rejected += 1;
            }

            await logModeration(env, {
                sha256: row.sha256,
                objectKey: row.object_key,
                outcome: result.verdict,
                source: "sweep",
                attempt: row.attempts + 1,
                scores: result.scores,
                reasons: result.reasons,
            });

            await env.DB.prepare(
                `UPDATE image_moderation SET verdict = ?, adult = ?, racy = ?, violence = ?, medical = ?,
                 spoof = ?, checked_at = strftime('%s','now'), last_error = NULL WHERE sha256 = ?`,
            )
                .bind(
                    result.verdict,
                    result.scores.adult,
                    result.scores.racy,
                    result.scores.violence,
                    result.scores.medical,
                    result.scores.spoof,
                    row.sha256,
                )
                .run();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Bounded retries, so one undecodable image cannot occupy the queue forever.
            await env.DB.prepare(
                "UPDATE image_moderation SET attempts = attempts + 1, last_error = ? WHERE sha256 = ?",
            )
                .bind(message.slice(0, 200), row.sha256)
                .run();

            // Every failed attempt, not just the last. Five rows saying "429" is a quota problem;
            // five different messages is something else, and `last_error` alone cannot tell them
            // apart because each retry overwrites the one before.
            await logModeration(env, {
                sha256: row.sha256,
                objectKey: row.object_key,
                outcome: "error",
                source: "sweep",
                attempt: row.attempts + 1,
                error: message,
            });
        }
    }

    return {scanned, rejected};
}

/// After this many failures an image stops being retried and stays visible in the pending count,
/// where a human can look at it. Silently giving up would be worse than a queue that nags.
const MAX_MODERATION_ATTEMPTS = 5;

/// Deliberately does not say which category tripped, or how close the others came. That detail
/// is a tuning guide for anyone probing the threshold, and it is in D1 for us either way.
const REFUSAL_MESSAGE = "This image was refused by automated content screening. Please use different badge art.";

interface ModerationLogEntry {
    sha256: string;
    objectKey?: string | null;
    outcome: "allow" | "reject" | "error";
    source: "upload" | "sweep";
    attempt?: number;
    scores?: SafeSearchScores;
    reasons?: string[];
    error?: string;
    submittedBy?: string | null;
}

/// Appends to the screening history. Never throws: a decision has already been made by the time
/// this is called, and losing the audit row must not change it or fail the request.
///
/// Also mirrored to `console.log`, so a failure is visible in `wrangler tail` during an incident
/// without anyone having to query D1 first.
async function logModeration(env: Env, entry: ModerationLogEntry): Promise<void> {
    const detail =
        entry.outcome === "error"
            ? `error=${entry.error ?? "unknown"}`
            : `adult=${describeScore(entry.scores?.adult ?? 0)} racy=${describeScore(entry.scores?.racy ?? 0)} ` +
              `violence=${describeScore(entry.scores?.violence ?? 0)} medical=${describeScore(entry.scores?.medical ?? 0)} ` +
              `spoof=${describeScore(entry.scores?.spoof ?? 0)}`;
    console.log(
        `moderation ${entry.outcome} via ${entry.source} sha=${entry.sha256} ` +
            `key=${entry.objectKey ?? "-"} attempt=${entry.attempt ?? 0} ${detail}` +
            (entry.reasons?.length ? ` reasons=${entry.reasons.join(",")}` : ""),
    );

    try {
        await env.DB.prepare(
            `INSERT INTO moderation_events
                 (sha256, object_key, outcome, source, attempt, adult, racy, violence, medical, spoof,
                  reasons, error, submitted_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
            .bind(
                entry.sha256,
                entry.objectKey ?? null,
                entry.outcome,
                entry.source,
                entry.attempt ?? 0,
                entry.scores?.adult ?? null,
                entry.scores?.racy ?? null,
                entry.scores?.violence ?? null,
                entry.scores?.medical ?? null,
                entry.scores?.spoof ?? null,
                entry.reasons?.join(",") ?? null,
                entry.error?.slice(0, 500) ?? null,
                entry.submittedBy?.toLowerCase() ?? null,
            )
            .run();
    } catch (caught) {
        console.error(`moderation log write failed for ${entry.sha256}: ${String(caught)}`);
    }
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim();

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        return json({error: `Unsupported content type: ${contentType || "(none)"}`}, 415);
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_UPLOAD_BYTES) return json({error: "Upload exceeds 5 MB."}, 413);

    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return json({error: "Upload exceeds 5 MB."}, 413);
    if (bytes.byteLength === 0) return json({error: "Empty upload."}, 400);

    // Hash first: the digest is both the authorization subject and the object key.
    const digest = await sha256Hex(bytes);

    const rejection = await checkUploadAuth(request, env, digest);
    if (rejection) return rejection;

    // Only after authorization: moderation costs money per call, and an unauthenticated caller
    // must not be able to spend it.
    const submittedBy = request.headers.get(UPLOAD_HEADERS.address);
    const {refusal, pending} = await moderate(bytes, digest, submittedBy, contentType, env);
    if (refusal) return refusal;

    const key = `${digest.slice(0, 32)}.${EXTENSIONS[contentType] ?? "bin"}`;

    await env.ASSETS_BUCKET.put(key, bytes, {
        httpMetadata: {
            contentType,
            // Content-addressed, so it can never change under a given key.
            cacheControl: "public, max-age=31536000, immutable",
        },
    });

    // Recorded after the object exists, so the sweep is never handed a key pointing at nothing.
    if (pending) {
        try {
            await env.DB.prepare(
                `INSERT INTO image_moderation (sha256, verdict, object_key, submitted_by)
                 VALUES (?, 'pending', ?, ?)
                 ON CONFLICT(sha256) DO UPDATE SET object_key = excluded.object_key`,
            )
                .bind(digest, key, submittedBy?.toLowerCase() ?? null)
                .run();
        } catch (error) {
            // This is the one bookkeeping failure that matters: without the row the image is
            // served and nothing will ever screen it. Loud, since it needs a human.
            console.error(`moderation queue write FAILED for ${key}: ${String(error)}`);
        }
    }

    // Derived from the request rather than configured, so the URL is correct on
    // workers.dev, on a custom domain, and in local dev without another setting to drift.
    const origin = new URL(request.url).origin;
    return json({key, url: `${origin}/api/asset/${key}`}, 201);
}

async function handleAsset(key: string, env: Env): Promise<Response> {
    const object = await env.ASSETS_BUCKET.get(key);
    if (!object) return json({error: "Not found"}, 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    // These stop the response being interpreted as an active document even if a stored
    // content type is ever wrong or the allowlist is widened carelessly.
    headers.set("content-security-policy", "default-src 'none'; sandbox");
    headers.set("x-content-type-options", "nosniff");
    // Must stay `cross-origin`: badge art is loaded by the dashboard on another origin and
    // by marketplaces rendering the NFT metadata. `same-origin` here would break both.
    headers.set("cross-origin-resource-policy", "cross-origin");

    return new Response(object.body, {headers});
}

/// Reports each dependency separately. A 503 here means the Worker is up but cannot serve
/// claims, which is a different page for whoever is on call than a 500 from the edge.
async function handleHealth(env: Env): Promise<Response> {
    const checks: Record<string, string> = {};

    // Reads the schema rather than `SELECT 1`, so a database that exists but has never been
    // migrated reports unhealthy instead of passing.
    try {
        await env.DB.prepare("SELECT 1 FROM claim_codes LIMIT 1").all();
        checks.d1 = "ok";
    } catch (error) {
        checks.d1 = `error: ${error instanceof Error ? error.message : String(error)}`;
    }

    // A HEAD on a key that is not expected to exist. Returns null on a healthy empty bucket
    // and throws only when the binding or the bucket itself is wrong.
    try {
        await env.ASSETS_BUCKET.head("healthcheck");
        checks.r2 = "ok";
    } catch (error) {
        checks.r2 = `error: ${error instanceof Error ? error.message : String(error)}`;
    }

    // Reported but not counted towards health: an unconfigured moderator is a deployment state,
    // not an outage, and paging someone for it would be wrong. Visible so that "is screening on?"
    // never has to be answered by reading the deploy logs.
    const moderation = env.GOOGLE_VISION_API_KEY ? "active" : "disabled (no GOOGLE_VISION_API_KEY)";

    // The queue depth is the number that matters under fail-open: how many images are being
    // served without having been screened. Split, because the two halves need different reactions
    // — `retrying` drains on its own, `awaitingReview` never will and is a job for a person.
    let unscreened: {retrying: number; awaitingReview: number} | string;
    try {
        // The attempt ceiling is interpolated, not bound. D1 does not reliably bind a parameter
        // used in a comparison inside an aggregate filter — with `?` this counted an image on its
        // sixth attempt as still retrying. It is a module constant rather than user input, so
        // there is nothing here to inject.
        const row = await env.DB.prepare(
            `SELECT
                 COALESCE(SUM(CASE WHEN attempts <  ${MAX_MODERATION_ATTEMPTS} THEN 1 ELSE 0 END), 0) AS retrying,
                 COALESCE(SUM(CASE WHEN attempts >= ${MAX_MODERATION_ATTEMPTS} THEN 1 ELSE 0 END), 0) AS awaiting
             FROM image_moderation WHERE verdict = 'pending'`,
        ).first<{retrying: number; awaiting: number}>();
        unscreened = {retrying: row?.retrying ?? 0, awaitingReview: row?.awaiting ?? 0};
    } catch (error) {
        unscreened = `unknown: ${error instanceof Error ? error.message : String(error)}`;
    }

    const ok = Object.values(checks).every((v) => v === "ok");
    return json({ok, checks, moderation, unscreened}, ok ? 200 : 503);
}

async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Touches both bindings rather than returning a bare literal: a missing binding, an
    // unapplied migration, or a bucket that was never created is exactly the class of
    // mistake a health check should catch, and all three are invisible until first use.
    if (url.pathname === "/api/health") return handleHealth(env);

    if (url.pathname === "/api/upload") {
        if (request.method !== "POST") return json({error: "Method not allowed"}, 405);
        return handleUpload(request, env);
    }

    if (url.pathname.startsWith("/api/asset/")) {
        // HEAD as well as GET. NFT indexers, wallet image proxies, and caches routinely HEAD a
        // metadata or image URL to learn its type and size before deciding to fetch it, and a 405
        // there reads as a broken asset rather than an unsupported method. The Workers runtime
        // drops the body from a HEAD response on its own, so the handler needs no special case.
        if (request.method !== "GET" && request.method !== "HEAD") {
            return json({error: "Method not allowed"}, 405);
        }
        const key = url.pathname.slice("/api/asset/".length);
        if (!/^[a-f0-9]{32}\.[a-z]{3,4}$/.test(key)) return json({error: "Bad key"}, 400);
        return handleAsset(key, env);
    }

    return json({error: "Not found"}, 404);
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (request.method === "OPTIONS") return withCors(handlePreflight(request, env), request, env);
        return withCors(await route(request, env), request, env);
    },

    /// Drains the unscreened queue. This is the other half of failing open — without it, an image
    /// admitted during an outage is never looked at, and screening becomes advisory.
    async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        ctx.waitUntil(
            sweepPending(env).then(({scanned, rejected}) => {
                if (scanned > 0 || rejected > 0) {
                    console.log(`moderation sweep: scanned ${scanned}, removed ${rejected}`);
                }
            }),
        );
    },
} satisfies ExportedHandler<Env>;
