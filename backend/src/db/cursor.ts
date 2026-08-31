/**
 * cursor.ts — shared cursor-pagination utilities.
 *
 * Cursor format: base64url-encoded JSON keyset payload.
 * Tasks  keyset: { createdAt, id }
 * Agents keyset: { lastSeenAt, id }
 *
 * Using a compound (timestamp, id) keyset guarantees a total order that is
 * stable under concurrent inserts — new rows never shift existing pages.
 */

export interface TaskCursorPayload {
  createdAt: string;
  id: string;
}

export interface AgentCursorPayload {
  lastSeenAt: string;
  id: string;
}

type CursorPayload = TaskCursorPayload | AgentCursorPayload;

/** Encode a keyset into an opaque base64url string safe for query parameters. */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Decode a cursor string.  Returns null on any malformed input so callers
 * can treat a bad cursor like "no cursor" rather than throwing.
 */
export function decodeCursor(cursor: string): (TaskCursorPayload & AgentCursorPayload) | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as TaskCursorPayload & AgentCursorPayload;
  } catch {
    return null;
  }
}

/** Generic paginated page returned by all cursor-based list methods. */
export interface CursorPage<T> {
  items: T[];
  /** Opaque cursor for the next page. Absent when this is the last page. */
  nextCursor?: string;
}
