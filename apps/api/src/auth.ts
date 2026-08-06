/// Operator authentication: Google Sign-In, verified in the Worker.
///
/// The same shape as the Tandemonium dashboard — Google Identity Services hands the browser an
/// ID token, and the server verifies it as an RS256 JWT against Google's published keys rather
/// than trusting anything the client decoded for itself.
///
/// One deliberate difference: Tandemonium exchanges the Google token for its own HS256 JWT,
/// because it has a users table, profiles, and a second auth provider to normalise. This has an
/// email allowlist and nothing else, so the Google token *is* the session. That removes a signing
/// secret to hold and a session store to keep, at the cost of the browser re-acquiring a token
/// roughly hourly — which Google Identity Services does silently for an already-signed-in user.
///
/// This gates the moderation queue, which is genuinely private. It does not meaningfully protect
/// event data: that is on a public blockchain and anyone can read it directly.

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const VALID_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

/// Google rotates signing keys slowly; refetching per request would add a round trip to every
/// authenticated call for nothing. The isolate may be recycled at any time, so this is a cache
/// rather than a guarantee.
let cachedJwks: {keys: JsonWebKey[]} | null = null;
let cachedJwksExpiry = 0;

async function fetchGoogleJwks(): Promise<{keys: JsonWebKey[]}> {
    const now = Date.now();
    if (cachedJwks && now < cachedJwksExpiry) return cachedJwks;

    const res = await fetch(GOOGLE_JWKS_URL, {cf: {cacheEverything: true, cacheTtl: 21600}});
    if (!res.ok) throw new Error("Could not fetch Google signing keys");

    cachedJwks = (await res.json()) as {keys: JsonWebKey[]};
    cachedJwksExpiry = now + 6 * 60 * 60 * 1000;
    return cachedJwks;
}

function base64UrlDecode(value: string): Uint8Array {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export interface GoogleIdentity {
    email: string;
    name?: string;
    picture?: string;
    sub: string;
}

/// Verifies a Google ID token's signature and claims. Throws with a reason on any failure.
export async function verifyGoogleIdToken(token: string, expectedAudience: string): Promise<GoogleIdentity> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Malformed token");

    // Parsed defensively: an unparseable token should read as "malformed", not as whatever the
    // JSON decoder happened to say about byte 3 of somebody's junk input.
    let header: {alg?: string; kid?: string};
    try {
        header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as typeof header;
    } catch {
        throw new Error("Malformed token");
    }
    // Pinned, so a token cannot talk the verifier into a weaker algorithm — `alg: none` and
    // HMAC-with-the-public-key are the classic JWT forgeries.
    if (header.alg !== "RS256") throw new Error("Unsupported token algorithm");

    const jwks = await fetchGoogleJwks();
    const jwk = jwks.keys.find((k) => (k as {kid?: string}).kid === header.kid);
    if (!jwk) throw new Error("Unknown signing key");

    const key = await crypto.subtle.importKey("jwk", jwk, {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, [
        "verify",
    ]);

    const valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        base64UrlDecode(parts[2]),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) throw new Error("Invalid token signature");

    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))) as Record<string, unknown>;
    } catch {
        throw new Error("Malformed token");
    }

    if (!VALID_ISSUERS.has(String(payload.iss))) throw new Error("Invalid token issuer");
    // Without this, a token minted for any other Google app would be accepted here.
    if (payload.aud !== expectedAudience) throw new Error("Token was not issued for this app");
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
        throw new Error("Token expired");
    }
    // An unverified email can be an address the holder does not control, which would make the
    // allowlist meaningless.
    if (payload.email_verified !== true) throw new Error("Google account email is not verified");
    if (typeof payload.email !== "string") throw new Error("Token carries no email");

    return {
        email: payload.email.toLowerCase(),
        name: typeof payload.name === "string" ? payload.name : undefined,
        picture: typeof payload.picture === "string" ? payload.picture : undefined,
        sub: String(payload.sub),
    };
}

export interface OperatorEnv {
    GOOGLE_CLIENT_ID?: string;
    OPERATOR_EMAILS?: string;
}

export type OperatorCheck = {ok: true; operator: GoogleIdentity} | {ok: false; status: number; error: string};

/// Authorizes an operator request from its `Authorization: Bearer` header.
///
/// Returns 404 rather than 401 when operator access is unconfigured, so an unconfigured
/// deployment does not advertise the existence of endpoints it cannot authorize.
export async function requireOperator(request: Request, env: OperatorEnv): Promise<OperatorCheck> {
    if (!env.GOOGLE_CLIENT_ID || !env.OPERATOR_EMAILS) {
        return {ok: false, status: 404, error: "Not found"};
    }

    const header = request.headers.get("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) return {ok: false, status: 401, error: "Sign in to continue."};

    let identity: GoogleIdentity;
    try {
        identity = await verifyGoogleIdToken(token, env.GOOGLE_CLIENT_ID);
    } catch (error) {
        return {ok: false, status: 401, error: error instanceof Error ? error.message : "Invalid token"};
    }

    const allowed = env.OPERATOR_EMAILS.split(",").map((e) => e.trim().toLowerCase());
    if (!allowed.includes(identity.email)) {
        // Deliberately does not say the sign-in worked. Confirming a valid Google account that is
        // merely not on the list is more than an unauthorized caller needs to learn.
        return {ok: false, status: 403, error: "This account does not have operator access."};
    }

    return {ok: true, operator: identity};
}
