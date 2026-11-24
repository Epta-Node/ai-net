/**
 * Client-side file download helpers.
 *
 * Centralised so every "export" affordance in the app produces the same
 * artefact: correct extension for the format, a MIME type the OS will act on,
 * a collision-resistant but human-readable filename, and a properly revoked
 * object URL. Issue #400 requires that "download produces the correct filename
 * and format", which is only enforceable if the two live in one place.
 */

/** Formats an agent output can be exported as. */
export type ExportFormat = 'json' | 'markdown' | 'text' | 'code';

interface FormatSpec {
  extension: string;
  mimeType: string;
}

/**
 * `text/plain` rather than `text/markdown` for `.md`: several browsers still
 * download instead of navigating for the latter, but the filename alone is
 * enough for editors and GitHub to pick the right highlighter.
 */
const FORMAT_SPECS: Record<ExportFormat, FormatSpec> = {
  json: { extension: 'json', mimeType: 'application/json' },
  markdown: { extension: 'md', mimeType: 'text/markdown;charset=utf-8' },
  text: { extension: 'txt', mimeType: 'text/plain;charset=utf-8' },
  code: { extension: 'txt', mimeType: 'text/plain;charset=utf-8' },
};

export function extensionForFormat(format: ExportFormat): string {
  return FORMAT_SPECS[format].extension;
}

/**
 * Strip characters that are illegal (or merely annoying) in a filename.
 *
 * Anything outside `[A-Za-z0-9._-]` becomes a dash. Truncating to 64 chars
 * keeps the name under the ~255-byte limit on every major filesystem while
 * leaving room for the suffix.
 */
export function sanitizeFilenameSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
}

/**
 * Build a filename like `agent-output-node-research-2026-09-26T10-15-00.json`.
 *
 * The timestamp uses `-` instead of `:` because colons are illegal in
 * filenames on Windows and macOS's HFS+ tooling.
 */
export function buildOutputFilename(base: string, format: ExportFormat, now: Date = new Date()): string {
  const segment = sanitizeFilenameSegment(base) || 'output';
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
  return `${segment}-${stamp}.${extensionForFormat(format)}`;
}

/**
 * Trigger a browser download for `content`.
 *
 * `URL.revokeObjectURL` is deferred to the next macrotask on purpose:
 * revoking synchronously right after `click()` races the browser's own read of
 * the blob URL and intermittently produces an empty file in Safari.
 */
export function downloadTextFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Copy `text` to the clipboard, falling back to a hidden textarea when the
 * async Clipboard API is unavailable (non-secure context, older Safari).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textArea);
    return ok;
  } catch {
    return false;
  }
}
