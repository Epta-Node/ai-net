import request from "supertest";
import { createApp } from "../src/api/app";

/**
 * Every response carries `X-API-Version` (#922), including the ones answered before the route handlers run: a
 * malformed JSON body, a CORS preflight and an unknown path.
 */
describe("X-API-Version header", () => {
  let app: ReturnType<typeof createApp>["httpServer"];
  let closeApp: () => void;

  beforeAll(() => {
    const instance = createApp();
    app = instance.httpServer;
    closeApp = instance.close;
  });

  afterAll((done) => {
    closeApp();
    done();
  });

  it("is set on a successful response and names a major.minor version", async () => {
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.headers["x-api-version"]).toMatch(/^\d+\.\d+$/);
  });

  it("is set on a 404 for an unknown path", async () => {
    const res = await request(app).get("/no-such-route-for-version-header");
    expect(res.status).toBe(404);
    expect(res.headers["x-api-version"]).toMatch(/^\d+\.\d+$/);
  });

  it("is set on a 400 for a malformed JSON body", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set("Content-Type", "application/json")
      .send('{"not valid json"');
    expect(res.status).toBe(400);
    expect(res.headers["x-api-version"]).toMatch(/^\d+\.\d+$/);
  });

  it("is set on a CORS preflight answered before the routes", async () => {
    const res = await request(app)
      .options("/api/tasks")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "POST");
    expect(res.headers["x-api-version"]).toMatch(/^\d+\.\d+$/);
  });

  it("is set on a 400 for an unsupported version requested by the client", async () => {
    const res = await request(app).get("/health/live").set("API-Version", "9.9");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNSUPPORTED_API_VERSION");
    expect(res.headers["x-api-version"]).toMatch(/^\d+\.\d+$/);
  });
});
