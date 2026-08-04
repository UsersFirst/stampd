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
    /// Comma-separated origins permitted to call this API from a browser.
    ALLOWED_ORIGINS: string;
    /// Chain whose state is consulted to verify smart-contract-wallet signatures.
    VERIFY_CHAIN_ID: string;
    RPC_URL: string;
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

    if (!address || !issued || !signature) return json({error: "Missing upload authorization."}, 401);
    if (!isAddress(address)) return json({error: "Malformed address."}, 401);
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) return json({error: "Malformed signature."}, 401);

    const issuedAt = Number(issued);
    if (!Number.isInteger(issuedAt)) return json({error: "Malformed timestamp."}, 401);

    const skew = Math.abs(Math.floor(Date.now() / 1000) - issuedAt);
    if (skew > UPLOAD_AUTH_WINDOW_SECONDS) {
        return json({error: "Authorization expired; sign again."}, 401);
    }

    const message = buildUploadAuthMessage({address: address as Address, sha256: digest, issuedAt});

    // Plain EOA signatures verify offline. Smart-contract wallets (ERC-1271/6492) need
    // chain state, so only those pay for an RPC round-trip.
    try {
        const recovered = await recoverMessageAddress({message, signature: signature as `0x${string}`});
        if (recovered.toLowerCase() === address.toLowerCase()) return null;
    } catch {
        // fall through to on-chain verification
    }

    try {
        const chain = env.VERIFY_CHAIN_ID === String(base.id) ? base : baseSepolia;
        const client = createPublicClient({chain, transport: http(env.RPC_URL)});
        const valid = await client.verifyMessage({
            address: address as Address,
            message,
            signature: signature as `0x${string}`,
        });
        if (valid) return null;
    } catch {
        return json({error: "Could not verify signature."}, 503);
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

async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") return json({ok: true});

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
        if (request.method === "OPTIONS") return handlePreflight(request, env);
        return withCors(await route(request, env), request, env);
    },
} satisfies ExportedHandler<Env>;
