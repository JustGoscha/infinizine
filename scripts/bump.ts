// bun run bump patch|minor|major — bumps package.json and stages it for the commit.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const kind = process.argv[2] as 'patch' | 'minor' | 'major' | undefined;
if (!kind || !['patch', 'minor', 'major'].includes(kind)) {
  console.error('usage: bun run bump patch|minor|major');
  process.exit(1);
}
const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [ma, mi, pa] = pkg.version.split('.').map(Number);
const next = kind === 'major' ? `${ma + 1}.0.0` : kind === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
execSync('git add package.json');
console.log(`version ${next} (${kind}) — staged package.json`);
if (kind === 'major') console.log('reminder: bump FORMAT_VERSION in src/types.ts and add a migration step in store.ts');
