import type {Address} from "./chains.js";

/// Uploads are authorized by a wallet signature rather than a session, so the Worker holds
/// no secret and stores no nonce.
///
/// The signed message commits to the SHA-256 of the body, which is what makes this safe to
/// keep stateless: a captured signature can only ever re-upload the identical bytes, and
/// because object keys are content-addressed that is a no-op rather than an attack. The
/// timestamp bounds how long a captured signature stays useful at all.

export const UPLOAD_AUTH_WINDOW_SECONDS = 300;

export const UPLOAD_HEADERS = {
    address: "x-stampd-address",
    issued: "x-stampd-issued",
    signature: "x-stampd-signature",
    filename: "x-stampd-filename",
} as const;

export interface UploadAuth {
    address: Address;
    sha256: string;
    issuedAt: number;
}

export function buildUploadAuthMessage(auth: UploadAuth): string {
    return [
        "stampd upload authorization",
        "",
        `address: ${auth.address.toLowerCase()}`,
        `sha256: ${auth.sha256}`,
        `issued: ${auth.issuedAt}`,
    ].join("\n");
}

/// Available in both the browser and Workers, so client and server hash identically.
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
