import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    format: ["cjs", "esm"], // Add CommonJS format
    external: [
        "dotenv", // Externalize dotenv to prevent bundling
        "fs", // Externalize fs to use Node.js built-in module
        "path", // Externalize other built-ins if necessary
        "@reflink/reflink",
        "@node-llama-cpp",
        "https",
        "http",
        "agentkeepalive",
        "fluent-ffmpeg",
        "@anush008/tokenizers",
        "@elizaos/plugin-solana",
        // Add other modules you want to externalize
    ],
    noExternal: [
        // Add any packages that should be bundled
    ],
    platform: 'node',
    target: 'node16',
    dts: true,
    shims: true, // Add shims for better compatibility
    treeshake: true
});
