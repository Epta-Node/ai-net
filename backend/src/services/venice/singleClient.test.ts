import fs from 'fs';
import path from 'path';

describe('VeniceClient Single Canonical Service Guard', () => {
  it('should ensure the obsolete backend/src/venice directory does not exist', () => {
    const obsoletePath = path.resolve(__dirname, '../../venice');
    expect(fs.existsSync(obsoletePath)).toBe(false);
  });

  it('should ensure only one VeniceClient class definition exists in backend/src', () => {
    const srcRoot = path.resolve(__dirname, '../..');
    const matches: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(fullPath);
          continue;
        }

        if (!entry.name.endsWith('.ts')) continue;

        const source = fs.readFileSync(fullPath, 'utf8');
        if (/\bclass\s+VeniceClient\b/.test(source) || /\bexport\s+class\s+VeniceClient\b/.test(source)) {
          matches.push(fullPath);
        }
      }
    }

    walk(srcRoot);

    expect(matches).toHaveLength(1);
    expect(path.relative(srcRoot, matches[0])).toBe('services/venice/client.ts');
  });
});