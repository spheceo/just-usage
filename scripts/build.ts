// Bundles src/cli.ts into a single Node-compatible ESM file at dist/cli.js.
// Bun is the toolchain; the published artifact runs on plain Node 20+ (and Bun).
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const outdir = "dist";
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  outdir,
  target: "node",
  format: "esm",
  naming: "cli.js",
  minify: false,
  sourcemap: "none",
  loader: { ".html": "text", ".svg": "text" },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const outfile = `${outdir}/cli.js`;
let code = await readFile(outfile, "utf8");
if (!code.startsWith("#!")) code = `#!/usr/bin/env node\n${code}`;
await writeFile(outfile, code);
await chmod(outfile, 0o755);

const bytes = Buffer.byteLength(code);
console.log(`built ${outfile} (${(bytes / 1024).toFixed(1)} kB)`);
