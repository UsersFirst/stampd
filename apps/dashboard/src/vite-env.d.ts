/// <reference types="vite/client" />

interface ImportMetaEnv {
    /// Origin of the deployed Worker API, e.g. https://stampd-api.<account>.workers.dev
    /// Empty in local development, where Vite proxies /api to the local Worker.
    readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
