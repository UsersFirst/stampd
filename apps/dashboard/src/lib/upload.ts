/// Uploads go to the Worker on the same origin (/api/*), so there is no CORS preflight.
/// The Worker stores the object in R2 and returns the URL it will serve it back from.

interface UploadResponse {
    url: string;
    key: string;
}

async function post(body: BodyInit, contentType: string, filename: string): Promise<string> {
    const res = await fetch("/api/upload", {
        method: "POST",
        headers: {
            "content-type": contentType,
            "x-stampd-filename": filename,
        },
        body,
    });

    if (!res.ok) {
        throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
    }

    const {url} = (await res.json()) as UploadResponse;
    return url;
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function uploadImage(file: File): Promise<string> {
    if (file.size > MAX_IMAGE_BYTES) {
        throw new Error(`Badge art must be under ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    }
    return post(file, file.type || "application/octet-stream", file.name);
}

export async function uploadMetadata(metadata: unknown): Promise<string> {
    return post(JSON.stringify(metadata, null, 2), "application/json", "metadata.json");
}
