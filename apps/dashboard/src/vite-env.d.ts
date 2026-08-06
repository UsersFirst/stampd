/// <reference types="vite/client" />

interface ImportMetaEnv {
    /// Origin of the deployed Worker API, e.g. https://stampd-api.<account>.workers.dev
    /// Empty in local development, where Vite proxies /api to the local Worker.
    readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

interface ImportMetaEnv {
    readonly VITE_API_BASE_URL?: string;
    /// Google OAuth client id for the operator sign-in. Absent means the Operator tab explains
    /// that it is unconfigured rather than rendering a sign-in button that cannot work.
    readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
