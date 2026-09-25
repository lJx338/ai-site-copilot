import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "templates/site-project");
const files = {};

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".vite", "pnpm-lock.yaml", "tsconfig.tsbuildinfo"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else files[path.relative(root, absolute).replaceAll(path.sep, "/")] = readFileSync(absolute, "utf8");
  }
}

walk(root);
writeFileSync(path.resolve(process.cwd(), "lib/project-template.ts"), `// Generated from templates/site-project.\nexport const templateFiles = ${JSON.stringify(files, null, 2)} as const;\n`);
console.log(`Synced ${Object.keys(files).length} template files.`);
