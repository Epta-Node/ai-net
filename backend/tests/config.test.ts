import fs from "fs";
import path from "path";
import { loadConfig, resetConfigForTests, envSchema } from "../src/config";

describe("config validation & schema parity", () => {
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

  it("defaults trusted proxies to none and parses hop counts", () => {
    expect(loadConfig({ NODE_ENV: "test" }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ NODE_ENV: "test", TRUST_PROXY: "2" }).TRUST_PROXY).toBe(
      2,
    );
  });
});
