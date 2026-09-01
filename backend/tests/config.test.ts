import { loadConfig, resetConfigForTests } from "../src/config";

describe("config validation", () => {
  afterEach(() => {
    resetConfigForTests();
  });

  it("reports invalid environment variables by name", () => {
    let message = "";
    try {
      loadConfig({
        ...process.env,
        NODE_ENV: "production",
        PORT: "not-a-port",
        DATABASE_URL: "",
        VENICE_API_KEY: "",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("PORT");
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("VENICE_API_KEY");
  });
});
