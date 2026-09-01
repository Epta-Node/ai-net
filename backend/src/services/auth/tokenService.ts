import crypto from "crypto";

export interface AccessTokenPayload {
  sub: string; // walletPublicKey
  sessionId: string;
  familyId: string;
  deviceId: string;
  iat: number; // seconds
  exp: number; // seconds
  jti: string; // unique token identifier
}

function base64UrlEncode(strOrBuffer: string | Buffer): string {
  const buf = typeof strOrBuffer === "string" ? Buffer.from(strOrBuffer, "utf-8") : strOrBuffer;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64").toString("utf-8");
}

export class TokenService {
  private jwtSecret: string;
  private accessTtlSeconds: number;
  private refreshTtlSeconds: number;
  private sessionMaxTtlSeconds: number;

  constructor(options?: {
    jwtSecret?: string;
    accessTtlSeconds?: number;
    refreshTtlSeconds?: number;
    sessionMaxTtlSeconds?: number;
  }) {
    this.jwtSecret = options?.jwtSecret ?? process.env.AUTH_JWT_SECRET ?? "ai-net-auth-secret";
    this.accessTtlSeconds = options?.accessTtlSeconds ?? 900; // 15 mins
    this.refreshTtlSeconds = options?.refreshTtlSeconds ?? 604800; // 7 days
    this.sessionMaxTtlSeconds = options?.sessionMaxTtlSeconds ?? 2592000; // 30 days
  }

  /**
   * Generates a cryptographically signed HMAC-SHA256 JWT access token.
   */
  public generateAccessToken(params: {
    walletPublicKey: string;
    sessionId: string;
    familyId: string;
    deviceId: string;
  }): { token: string; expiresIn: number } {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.accessTtlSeconds;
    const jti = crypto.randomUUID();

    const header = { alg: "HS256", typ: "JWT" };
    const payload: AccessTokenPayload = {
      sub: params.walletPublicKey,
      sessionId: params.sessionId,
      familyId: params.familyId,
      deviceId: params.deviceId,
      iat: now,
      exp,
      jti,
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const dataToSign = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto
      .createHmac("sha256", this.jwtSecret)
      .update(dataToSign)
      .digest();
    const encodedSignature = base64UrlEncode(signature);

    return {
      token: `${dataToSign}.${encodedSignature}`,
      expiresIn: this.accessTtlSeconds,
    };
  }

  /**
   * Verifies and decodes an HMAC-SHA256 JWT access token.
   */
  public verifyAccessToken(token: string): AccessTokenPayload {
    if (!token || typeof token !== "string") {
      throw new Error("Invalid token format");
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid token format");
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const dataToSign = `${encodedHeader}.${encodedPayload}`;

    const expectedSignature = crypto
      .createHmac("sha256", this.jwtSecret)
      .update(dataToSign)
      .digest();
    const expectedEncodedSignature = base64UrlEncode(expectedSignature);

    // Constant-time comparison
    const sigBuf = Buffer.from(encodedSignature);
    const expBuf = Buffer.from(expectedEncodedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error("Invalid token signature");
    }

    let payload: AccessTokenPayload;
    try {
      payload = JSON.parse(base64UrlDecode(encodedPayload)) as AccessTokenPayload;
    } catch {
      throw new Error("Malformed token payload");
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      throw new Error("Token expired");
    }

    return payload;
  }

  /**
   * Generates a high-entropy random refresh token.
   */
  public generateRefreshToken(): string {
    const randomBytes = crypto.randomBytes(32).toString("hex");
    const uuid = crypto.randomUUID();
    return `rt_${uuid}_${randomBytes}`;
  }

  /**
   * Computes SHA-256 hash of a refresh token for database persistence and querying.
   */
  public hashRefreshToken(rawToken: string): string {
    return crypto.createHash("sha256").update(rawToken).digest("hex");
  }

  public getAccessTtlSeconds(): number {
    return this.accessTtlSeconds;
  }

  public getRefreshTtlSeconds(): number {
    return this.refreshTtlSeconds;
  }

  public getSessionMaxTtlSeconds(): number {
    return this.sessionMaxTtlSeconds;
  }
}
