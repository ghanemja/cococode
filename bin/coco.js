#!/usr/bin/env node
// Launcher. Uses the compiled build when there is one; otherwise runs the
// TypeScript sources directly, which Node can do since 22.18 (type stripping).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`coco needs Node.js 22.18 or newer (this is ${process.versions.node}).\n`);
  process.exit(1);
}

const dist = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const src = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
// The sources are preferred in a checkout so edits take effect without a rebuild.
const entry = existsSync(src) && !process.env.COCO_USE_DIST ? src : dist;
if (!existsSync(entry)) {
  process.stderr.write('coco is not built. Run "npm run build" in the package directory.\n');
  process.exit(1);
}

const { main } = await import(entry);
try {
  const code = await main(process.argv.slice(2));
  // Flush stdout before exiting so piped output is not cut short.
  process.stdout.write('', () => process.exit(code));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
}
