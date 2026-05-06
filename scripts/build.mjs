import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, "src", "app", "app.html"), resolve(dist, "app.html"));
await cp(resolve(root, "src", "app", "app.css"), resolve(dist, "app.css"));
await cp(resolve(root, "src", "extension"), dist, { recursive: true });
await build({
  entryPoints: [resolve(root, "src", "app", "app.js")],
  outfile: resolve(dist, "app.js"),
  bundle: true,
  format: "iife",
  target: "chrome120",
  legalComments: "none"
});

console.log(`Built file:// friendly Chrome extension app to ${dist}`);
