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
            "access-control-allow-methods": "GET, POST, OPTIONS",
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

    const key = `${digest.slice(0, 32)}.${EXTENSIONS[contentType] ?? "bin"}`;

    await env.ASSETS_BUCKET.put(key, bytes, {
        httpMetadata: {
            contentType,
            // Content-addressed, so it can never change under a given key.
            cacheControl: "public, max-age=31536000, immutable",
        },
    });

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

    const ok = Object.values(checks).every((v) => v === "ok");
    return json({ok, checks}, ok ? 200 : 503);
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
        if (request.method !== "GET") return json({error: "Method not allowed"}, 405);
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
} satisfies ExportedHandler<Env>;
