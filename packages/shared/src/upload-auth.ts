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
    chain: "x-stampd-chain",
} as const;

export interface UploadAuth {
    address: Address;
    sha256: string;
    issuedAt: number;
    /// The chain the signature was produced on.
    ///
    /// Load-bearing for smart-contract wallets and irrelevant for EOAs. A Coinbase Smart Wallet
    /// verifies via ERC-1271 against a replay-safe hash whose EIP-712 domain includes the chain
    /// id, so a signature made on Base mainnet can never validate against the same wallet on
    /// Base Sepolia — by design, and no amount of retrying changes it. The verifier therefore has
    /// to check on the chain the signer was actually on.
    ///
    /// It is inside the signed message, not merely a header, so the chain cannot be swapped in
    /// transit to point the verifier somewhere the signature happens to validate.
    chainId: number;
}

export function buildUploadAuthMessage(auth: UploadAuth): string {
    return [
        "stampd upload authorization",
        "",
        `address: ${auth.address.toLowerCase()}`,
        `sha256: ${auth.sha256}`,
        `issued: ${auth.issuedAt}`,
        `chain: ${auth.chainId}`,
    ].join("\n");
}

/// Available in both the browser and Workers, so client and server hash identically.
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
