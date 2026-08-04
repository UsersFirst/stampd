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
    signMessage: (message: string) => Promise<`0x${string}`>;
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function post(body: ArrayBuffer, contentType: string, filename: string, ctx: UploadContext): Promise<string> {
    const digest = await sha256Hex(body);
    const issuedAt = Math.floor(Date.now() / 1000);
    const signature = await ctx.signMessage(buildUploadAuthMessage({address: ctx.address, sha256: digest, issuedAt}));

    const res = await fetch(apiUrl("/api/upload"), {
        method: "POST",
        headers: {
            "content-type": contentType,
            [UPLOAD_HEADERS.filename]: filename,
            [UPLOAD_HEADERS.address]: ctx.address,
            [UPLOAD_HEADERS.issued]: String(issuedAt),
            [UPLOAD_HEADERS.signature]: signature,
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

export async function uploadImage(file: File, ctx: UploadContext): Promise<string> {
    if (file.size > MAX_IMAGE_BYTES) {
        throw new Error(`Badge art must be under ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    }
    return post(await file.arrayBuffer(), file.type || "application/octet-stream", file.name, ctx);
}

export async function uploadMetadata(metadata: unknown, ctx: UploadContext): Promise<string> {
    const body = new TextEncoder().encode(JSON.stringify(metadata, null, 2));
    return post(body.buffer as ArrayBuffer, "application/json", "metadata.json", ctx);
}
