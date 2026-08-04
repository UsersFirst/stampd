import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";

// Served from the root of stampd.usersfirst.com via GitHub Pages, so base is "/".
// The Worker intercepts /api/* ahead of Pages, which is why dev proxies there too.
export default defineConfig({
    plugins: [react()],
    base: "/",
    build: {
        outDir: "dist",
        sourcemap: true,
    },
    server: {
        port: 5173,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:8787",
                changeOrigin: true,
            },
        },
    },
});
