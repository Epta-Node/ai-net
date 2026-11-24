import { loadConfig } from "../src/config";

/**
 * The retry budget a failed job gets before it is parked in the dead-letter queue (#920). The default is five
 * attempts, and JOB_MAX_ATTEMPTS overrides it.
 */
describe("job retry defaults (#920)", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.VENICE_API_KEY = process.env.VENICE_API_KEY || "test-venice-key";
    process.env.DATABASE_URL = process.env.DATABASE_URL || ":memory:";
    process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "test-admin-key-12345";
    delete process.env.JOB_MAX_ATTEMPTS;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("allows five attempts before a job is dead-lettered by default", () => {
    expect(loadConfig().JOB_MAX_ATTEMPTS).toBe(5);
  });

  it("honours JOB_MAX_ATTEMPTS when it is set", () => {
    process.env.JOB_MAX_ATTEMPTS = "8";
    expect(loadConfig().JOB_MAX_ATTEMPTS).toBe(8);
  });
});
