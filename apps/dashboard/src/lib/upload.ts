import {UPLOAD_HEADERS, buildUploadAuthMessage, sha256Hex, type Address} from "@stampd/shared";
import {apiUrl} from "./api";

/// Each upload is authorized by a wallet signature over the SHA-256 of the body. Binding
/// the signature to the content is what lets the Worker stay stateless: a captured
/// signature can only re-upload the identical bytes, which is a no-op against
/// content-addressed keys.

interface UploadResponse {
    url: string;
    key: string;
}

export interface UploadContext {
    address: Address;
    /// The chain the wallet is currently on. Smart-contract wallets sign chain-bound signatures,
    /// so the Worker has to verify on this chain rather than one it picked in advance.
    chainId: number;
    signMessage: (message: string) => Promise<`0x${string}`>;
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function post(body: ArrayBuffer, contentType: string, filename: string, ctx: UploadContext): Promise<string> {
    const digest = await sha256Hex(body);
    const issuedAt = Math.floor(Date.now() / 1000);
    const signature = await ctx.signMessage(
        buildUploadAuthMessage({address: ctx.address, sha256: digest, issuedAt, chainId: ctx.chainId}),
    );
    return send(body, contentType, filename, digest, issuedAt, signature, ctx);
}

/// Everything after the signature. Split out so the prepared path can sign before awaiting
/// anything, while this half stays shared.
async function send(
    body: ArrayBuffer,
    contentType: string,
    filename: string,
    _digest: string,
    issuedAt: number,
    signature: `0x${string}`,
    ctx: UploadContext,
): Promise<string> {
    const res = await fetch(apiUrl("/api/upload"), {
        method: "POST",
        headers: {
            "content-type": contentType,
            [UPLOAD_HEADERS.filename]: filename,
            [UPLOAD_HEADERS.address]: ctx.address,
            [UPLOAD_HEADERS.issued]: String(issuedAt),
            [UPLOAD_HEADERS.signature]: signature,
            [UPLOAD_HEADERS.chain]: String(ctx.chainId),
        },
        body,
    });

    if (!res.ok) {
        let detail = await res.text();
        try {
            detail = (JSON.parse(detail) as {error?: string}).error ?? detail;
        } catch {
            // keep the raw body
        }
        throw new Error(`Upload failed (${res.status}): ${detail}`);
    }

    const {url} = (await res.json()) as UploadResponse;
    return url;
}

/// An image read and hashed ahead of time, so that submitting can ask the wallet to sign without
/// awaiting anything first.
export interface PreparedUpload {
    bytes: ArrayBuffer;
    digest: string;
    contentType: string;
    filename: string;
}

/// Do this when the organizer picks the file, not when they submit.
///
/// A wallet that signs in a popup can only open one from the synchronous call stack of a user
/// gesture — mobile browsers discard the activation the moment you await. Reading and hashing the
/// file inside the submit handler put two awaits between the tap and `window.open`, so Safari
/// blocked the first signature every time. Hashing here leaves nothing to await on submit.
export async function prepareImage(file: File): Promise<PreparedUpload> {
    if (file.size > MAX_IMAGE_BYTES) {
        throw new Error(`Badge art must be under ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    }
    const bytes = await file.arrayBuffer();
    return {
        bytes,
        digest: await sha256Hex(bytes),
        contentType: file.type || "application/octet-stream",
        filename: file.name,
    };
}

/// Signs *first*, before any await, so the popup opens while the click is still active.
export async function uploadPreparedImage(prepared: PreparedUpload, ctx: UploadContext): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const signature = await ctx.signMessage(
        buildUploadAuthMessage({address: ctx.address, sha256: prepared.digest, issuedAt, chainId: ctx.chainId}),
    );
    return send(prepared.bytes, prepared.contentType, prepared.filename, prepared.digest, issuedAt, signature, ctx);
}

export async function uploadMetadata(metadata: unknown, ctx: UploadContext): Promise<string> {
    const body = new TextEncoder().encode(JSON.stringify(metadata, null, 2));
    return post(body.buffer as ArrayBuffer, "application/json", "metadata.json", ctx);
}
