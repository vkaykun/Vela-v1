import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    target: "node18",
    outDir: "dist",
    platform: "node",
    noExternal: ["@elizaos/core"],
    esbuildOptions(options) {
        options.banner = {
            js: `import { createRequire as _createRequire } from 'module';const require = _createRequire(import.meta.url);`,
        };
    },
});
