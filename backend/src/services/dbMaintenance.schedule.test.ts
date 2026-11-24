import { msUntilNextUtcHour } from './dbMaintenance';

const HOUR = 60 * 60 * 1000;

describe('msUntilNextUtcHour (#809 daily cold archive schedule)', () => {
  it('waits until the next 02:00 UTC when it is still early', () => {
    expect(msUntilNextUtcHour(new Date('2026-10-18T01:00:00.000Z'), 2)).toBe(HOUR);
  });

  it('waits until the next day when the hour has just passed', () => {
    expect(msUntilNextUtcHour(new Date('2026-10-18T03:00:00.000Z'), 2)).toBe(23 * HOUR);
  });

  it('counts an exact match as already passed, so the next run is a full day later', () => {
    expect(msUntilNextUtcHour(new Date('2026-10-18T02:00:00.000Z'), 2)).toBe(24 * HOUR);
  });

  it('rolls over a month boundary', () => {
    expect(msUntilNextUtcHour(new Date('2026-10-31T23:00:00.000Z'), 2)).toBe(3 * HOUR);
  });
});
