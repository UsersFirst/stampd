/// The Worker lives on *.workers.dev, a different origin to the GitHub Pages site, so
/// production calls need an absolute base URL. In development the Vite proxy forwards
/// /api to a local Worker, so a relative path is correct there.
///
/// Set VITE_API_BASE_URL at build time (repository variable of the same name in CI).

const BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

function isLocalHost(): boolean {
    const host = globalThis.location?.hostname ?? "";
    return host === "localhost" || host === "127.0.0.1";
}

export function apiUrl(path: string): string {
    if (!BASE && !isLocalHost()) {
        // Failing loudly here beats a confusing 404 from GitHub Pages, which serves the
        // SPA shell for unknown paths and would surface as a JSON parse error instead.
        throw new Error(
            "API base URL is not configured. Set VITE_API_BASE_URL to the deployed Worker origin and rebuild.",
        );
    }
    return `${BASE}${path}`;
}
