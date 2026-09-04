import fs from 'fs';
import path from 'path';

describe('VeniceClient Single Canonical Service Guard', () => {
  it('should ensure obsolete backend/src/venice directory does not exist', () => {
    const obsoletePath = path.resolve(__dirname, '../../venice');
    expect(fs.existsSync(obsoletePath)).toBe(false);
  });
});