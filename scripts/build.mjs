import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docs = resolve(root, "docs");
const vendor = resolve(docs, "vendor");

await rm(docs, { recursive: true, force: true });
await mkdir(docs, { recursive: true });
await mkdir(vendor, { recursive: true });
await cp(resolve(root, "src", "app", "index.html"), resolve(docs, "index.html"));
await cp(resolve(root, "src", "app", "app.css"), resolve(docs, "app.css"));
await cp(resolve(root, "src", "app", "site.webmanifest"), resolve(docs, "site.webmanifest"));
await cp(resolve(root, "src", "extension"), docs, { recursive: true });
await cp(resolve(root, "node_modules", "mermaid", "dist", "mermaid.min.js"), resolve(vendor, "mermaid.min.js"));
await build({
  entryPoints: [resolve(root, "src", "app", "app.js")],
  outfile: resolve(docs, "app.js"),
  bundle: true,
  format: "iife",
  target: "chrome120",
  legalComments: "none"
});

console.log(`Built file:// friendly Chrome extension app to ${docs}`);
