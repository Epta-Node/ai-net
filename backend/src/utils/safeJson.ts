import logger from "./logger";

/**
 * Longest raw column value echoed into a warning. The logger truncates fields
 * at `MAX_LOG_FIELD_LEN` anyway; keeping the preview short avoids dumping an
 * entire corrupted document into the log stream.
 */
const PREVIEW_LIMIT = 120;

const MALFORMED_MESSAGE = "ignoring malformed JSON array column";

function preview(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = typeof raw === "string" ? raw : String(raw);
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}...` : text;
}

/**
 * Decode a JSON-encoded `string[]` that was persisted to SQLite.
 *
 * A read path maps *every* row it touches, so an unguarded `JSON.parse` on a
 * corrupted column turns a single bad row into a 500 for the whole endpoint
 * (issue #645). This helper never throws: anything that is not a JSON array of
 * strings is reported through the logger and degrades to "no capabilities", so
 * one bad row can no longer take down the registry.
 *
 * @param raw     Raw column value exactly as SQLite returned it.
 * @param context Reader identifier (e.g. `agents.list`) for log correlation.
 * @param agentId Id of the row being decoded, so a failure names the offender.
 * @returns The decoded capabilities, or `[]` when the value is unusable.
 */
export function safeJsonArray(raw: unknown, context: string, agentId?: string): string[] {
  if (Array.isArray(raw)) {
    // Already-decoded values (in-memory records, fixtures) still get the same
    // string-only guarantee.
    return raw.filter((entry): entry is string => typeof entry === "string");
  }

  if (raw === null || raw === undefined || raw === "") {
    // The column is NOT NULL, but a missing value is a legitimate "no
    // capabilities" state rather than corruption, so this stays quiet.
    return [];
  }

  if (typeof raw !== "string") {
    logger.warn({ context, agentId, reason: "not-a-string", value: preview(raw) }, MALFORMED_MESSAGE);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ context, agentId, reason: "invalid-json", value: preview(raw) }, MALFORMED_MESSAGE);
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.warn({ context, agentId, reason: "not-an-array", value: preview(raw) }, MALFORMED_MESSAGE);
    return [];
  }

  const capabilities = parsed.filter((entry): entry is string => typeof entry === "string");
  if (capabilities.length !== parsed.length) {
    logger.warn({ context, agentId, reason: "non-string-entry", value: preview(raw) }, MALFORMED_MESSAGE);
  }
  return capabilities;
}
