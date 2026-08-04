/// stampd control plane.
///
/// Runs on a Worker route bound to stampd.usersfirst.com/api/*, ahead of the GitHub Pages
/// origin that serves the static apps. Same origin means no CORS and no preflight on the
/// claim path, which matters when a room full of people scan at once.
///
/// Today this handles badge art and metadata. Phase 3 adds D1-backed claim codes and
/// EIP-712 voucher signing alongside it.

export interface Env {
    ASSETS_BUCKET: R2Bucket;
    PUBLIC_ORIGIN: string;
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "application/json",
]);

const EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "application/json": "json",
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {"content-type": "application/json; charset=utf-8"},
    });
}

/// Content-addressed keys: the same bytes always land at the same URL, so a re-upload is
/// idempotent and metadata JSON pointing at art never goes stale.
async function contentKey(bytes: ArrayBuffer, contentType: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const extension = EXTENSIONS[contentType] ?? "bin";
    return `${hex.slice(0, 32)}.${extension}`;
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim();

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        return json({error: `Unsupported content type: ${contentType || "(none)"}`}, 415);
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_UPLOAD_BYTES) {
        return json({error: "Upload exceeds 5 MB."}, 413);
    }

    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        return json({error: "Upload exceeds 5 MB."}, 413);
    }
    if (bytes.byteLength === 0) {
        return json({error: "Empty upload."}, 400);
    }

    const key = await contentKey(bytes, contentType);

    await env.ASSETS_BUCKET.put(key, bytes, {
        httpMetadata: {
            contentType,
            // Content-addressed, so it can never change under a given key.
            cacheControl: "public, max-age=31536000, immutable",
        },
    });

    return json({key, url: `${env.PUBLIC_ORIGIN}/api/asset/${key}`}, 201);
}

async function handleAsset(key: string, env: Env): Promise<Response> {
    const object = await env.ASSETS_BUCKET.get(key);
    if (!object) return json({error: "Not found"}, 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    return new Response(object.body, {headers});
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/api/health") {
            return json({ok: true});
        }

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
    },
} satisfies ExportedHandler<Env>;
