import * as fs from 'node:fs';

/** Read from package.json so the version has a single source of truth. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const APP_NAME = 'coco';
