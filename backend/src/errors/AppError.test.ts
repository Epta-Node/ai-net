import { AppError } from "./AppError";
import { NotFoundError } from "./NotFoundError";
import { ValidationError } from "./ValidationError";
import { AuthenticationError } from "./AuthenticationError";
import { RateLimitError } from "./RateLimitError";
import { PaymentError } from "./PaymentError";

// ── AppError (base class) ────────────────────────────────────────────────────

describe("AppError", () => {
  it("creates an error with the correct properties", () => {
    const err = new AppError("Something broke", 500, "INTERNAL_ERROR");

    expect(err.message).toBe("Something broke");
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.name).toBe("AppError");
    expect(err.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(err.timestamp).toBeDefined();
    expect(new Date(err.timestamp).getTime()).not.toBeNaN();
  });

  it("accepts an explicit correlationId", () => {
    const correlationId = "test-correlation-id-123";
    const err = new AppError("msg", 400, "CODE", undefined, correlationId);

    expect(err.correlationId).toBe(correlationId);
  });

  it("stores optional details", () => {
    const details = { field: "email", reason: "already taken" };
    const err = new AppError("Conflict", 409, "CONFLICT", details);

    expect(err.details).toEqual(details);
  });

  it("is an instance of Error", () => {
    const err = new AppError("msg", 500, "CODE");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it("has a stack trace", () => {
    const err = new AppError("msg", 500, "CODE");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("AppError.test");
  });

  // ── serialize() ─────────────────────────────────────────────────────────────

  describe("serialize()", () => {
    it("returns a sanitized payload without details by default", () => {
      const err = new AppError("Oops", 500, "ERR", { secret: "value" });
      const payload = err.serialize();

      expect(payload.code).toBe("ERR");
      expect(payload.message).toBe("Oops");
      expect(payload.correlationId).toBe(err.correlationId);
      expect(payload.timestamp).toBe(err.timestamp);
      expect(payload.details).toBeUndefined();
    });

    it("includes details when includeDetails=true", () => {
      const details = { field: "prompt" };
      const err = new AppError("Validation failed", 400, "VALIDATION_ERROR", details);
      const payload = err.serialize(true);

      expect(payload.details).toEqual(details);
    });

    it("omits details when there are none even with includeDetails=true", () => {
      const err = new AppError("msg", 500, "CODE");
      const payload = err.serialize(true);

      expect(payload.details).toBeUndefined();
    });
  });
});

// ── NotFoundError ─────────────────────────────────────────────────────────────

describe("NotFoundError", () => {
  it("has statusCode 404 and code NOT_FOUND", () => {
    const err = new NotFoundError("Task");

    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Task not found");
    expect(err.name).toBe("NotFoundError");
  });

  it("includes the resource id in the message when provided", () => {
    const err = new NotFoundError("Agent", "agent-xyz");

    expect(err.message).toBe("Agent 'agent-xyz' not found");
  });

  it("is an instance of AppError", () => {
    expect(new NotFoundError("X")).toBeInstanceOf(AppError);
  });
});

// ── ValidationError ───────────────────────────────────────────────────────────

describe("ValidationError", () => {
  it("has statusCode 400 and code VALIDATION_ERROR", () => {
    const err = new ValidationError("Invalid input");

    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("Invalid input");
    expect(err.name).toBe("ValidationError");
  });

  it("stores validation details", () => {
    const details = { field: "pricingXLM", reason: "must be positive" };
    const err = new ValidationError("Validation failed", details);

    expect(err.details).toEqual(details);
  });

  it("is an instance of AppError", () => {
    expect(new ValidationError("msg")).toBeInstanceOf(AppError);
  });
});

// ── AuthenticationError ───────────────────────────────────────────────────────

describe("AuthenticationError", () => {
  it("has statusCode 401 and code AUTHENTICATION_ERROR", () => {
    const err = new AuthenticationError();

    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("AUTHENTICATION_ERROR");
    expect(err.message).toBe("Authentication required");
    expect(err.name).toBe("AuthenticationError");
  });

  it("accepts a custom message", () => {
    const err = new AuthenticationError("Invalid signature");
    expect(err.message).toBe("Invalid signature");
  });

  it("is an instance of AppError", () => {
    expect(new AuthenticationError()).toBeInstanceOf(AppError);
  });
});

// ── RateLimitError ────────────────────────────────────────────────────────────

describe("RateLimitError", () => {
  it("has statusCode 429 and code RATE_LIMIT_EXCEEDED", () => {
    const err = new RateLimitError();

    expect(err.statusCode).toBe(429);
    expect(err.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(err.message).toBe("Too many requests");
    expect(err.name).toBe("RateLimitError");
  });

  it("stores limit details", () => {
    const details = { limit: 100, window: "24h" };
    const err = new RateLimitError("Daily limit exceeded", details);

    expect(err.details).toEqual(details);
  });

  it("is an instance of AppError", () => {
    expect(new RateLimitError()).toBeInstanceOf(AppError);
  });
});

// ── PaymentError ──────────────────────────────────────────────────────────────

describe("PaymentError", () => {
  it("has statusCode 402 and code PAYMENT_ERROR", () => {
    const err = new PaymentError();

    expect(err.statusCode).toBe(402);
    expect(err.code).toBe("PAYMENT_ERROR");
    expect(err.message).toBe("Payment failed");
    expect(err.name).toBe("PaymentError");
  });

  it("accepts payment failure details", () => {
    const details = { required: 1.5, available: 0.2 };
    const err = new PaymentError("Insufficient XLM balance", details);

    expect(err.details).toEqual(details);
  });

  it("is an instance of AppError", () => {
    expect(new PaymentError()).toBeInstanceOf(AppError);
  });
});

// ── Cross-class behaviour ─────────────────────────────────────────────────────

describe("Error hierarchy", () => {
  const errorClasses = [
    NotFoundError,
    ValidationError,
    AuthenticationError,
    RateLimitError,
    PaymentError,
  ];

  it("NotFoundError inherits correlationId propagation", () => {
    const correlationId = "my-correlation-id";
    const err = new NotFoundError("Resource", undefined, undefined, correlationId);
    expect(err.correlationId).toBe(correlationId);
  });

  it.each([ValidationError, AuthenticationError, RateLimitError, PaymentError])(
    "%s inherits correlationId propagation",
    (ErrorClass) => {
      const correlationId = "my-correlation-id";
      const err = new (ErrorClass as any)("test", undefined, correlationId);
      expect(err.correlationId).toBe(correlationId);
    },
  );

  it.each(errorClasses)(
    "%s serialize() always includes correlationId and timestamp",
    (ErrorClass) => {
      const err = new (ErrorClass as any)("test");
      const payload = err.serialize();

      expect(payload.correlationId).toBe(err.correlationId);
      expect(payload.timestamp).toBe(err.timestamp);
    },
  );
});

// ── ConflictError (#424) ─────────────────────────────────────────────────────

import { ConflictError } from "./ConflictError";
import { ProviderError } from "./ProviderError";
import { ErrorCode, HTTP_STATUS_FOR_CODE, DEFAULT_MESSAGE_FOR_CODE } from "./ErrorCode";

describe("ConflictError", () => {
  it("uses 409 status and CONFLICT code", () => {
    const err = new ConflictError("Agent name taken");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("Agent name taken");
    expect(err).toBeInstanceOf(AppError);
  });

  it("has a sensible default message", () => {
    const err = new ConflictError();
    expect(err.message).toBeTruthy();
  });
});

// ── ProviderError (#424) ─────────────────────────────────────────────────────

describe("ProviderError", () => {
  it("defaults to 502 PROVIDER_ERROR", () => {
    const err = new ProviderError();
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe("PROVIDER_ERROR");
  });

  it("uses 504 for PROVIDER_TIMEOUT", () => {
    const err = new ProviderError("timed out", "PROVIDER_TIMEOUT");
    expect(err.statusCode).toBe(504);
    expect(err.code).toBe("PROVIDER_TIMEOUT");
  });

  it("uses 429 for PROVIDER_RATE_LIMITED", () => {
    const err = new ProviderError("rate limited", "PROVIDER_RATE_LIMITED");
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe("PROVIDER_RATE_LIMITED");
  });
});

// ── ErrorCode registry (#424) ─────────────────────────────────────────────────

describe("ErrorCode", () => {
  it("HTTP_STATUS_FOR_CODE has an entry for every code", () => {
    for (const code of Object.values(ErrorCode)) {
      expect(HTTP_STATUS_FOR_CODE[code]).toBeDefined();
    }
  });

  it("DEFAULT_MESSAGE_FOR_CODE has a non-empty message for every code", () => {
    for (const code of Object.values(ErrorCode)) {
      expect(DEFAULT_MESSAGE_FOR_CODE[code]).toBeTruthy();
    }
  });
});
