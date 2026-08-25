import { Request, Response, NextFunction } from 'express';
import { getConfig } from '../../config';

/**
 * API versioning middleware that handles header-based version negotiation.
 *
 * ### Version Negotiation
 * - Clients specify their desired API version via the `API-Version` header (e.g., "1.0", "1.1", "2.0")
 * - If the header is omitted, defaults to the configured default version (typically "1.0" for backward compatibility)
 * - Invalid or unsupported versions return a 400 error
 *
 * ### Response Headers
 * - `X-API-Version`: Echoes the API version used for the request
 * - `Deprecation`: Added for deprecated versions (e.g., v1.0)
 * - `Sunset`: Added for deprecated versions with a known sunset date
 *
 * ### Version Metadata
 * The negotiated version is stored in `res.locals.apiVersion` for use by
 * downstream route handlers and middleware.
 */
export function versioningMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Use default values if config is not loaded yet (e.g., during tests)
  let supportedVersions = ['1.0', '1.1', '2.0'];
  let latestVersion = '2.0';
  let defaultVersion = '1.0';
  let sunsetDate: string | undefined;

  try {
    const config = getConfig();
    supportedVersions = config.API_SUPPORTED_VERSIONS.split(',').map(v => v.trim());
    latestVersion = config.API_LATEST_VERSION;
    defaultVersion = config.API_DEFAULT_VERSION;
    sunsetDate = config.API_V1_SUNSET_DATE;
  } catch (error) {
    // Config not loaded, use defaults - this is acceptable for tests
  }

  // Get client-specified version from header
  const clientVersion = req.headers['api-version'] as string | undefined;

  // Default to configured default version if header is omitted (for backward compatibility)
  const negotiatedVersion = clientVersion || defaultVersion;

  // Validate the requested version
  if (!supportedVersions.includes(negotiatedVersion)) {
    res.status(400).json({
      error: {
        message: `Unsupported API version: "${negotiatedVersion}". Supported versions: ${supportedVersions.join(', ')}`,
        code: 'UNSUPPORTED_API_VERSION',
        supportedVersions,
      },
    });
    return;
  }

  // Store negotiated version for downstream handlers
  res.locals.apiVersion = negotiatedVersion;

  // Add version response header
  res.setHeader('X-API-Version', negotiatedVersion);

  // Add deprecation headers for old versions
  if (isDeprecatedVersion(negotiatedVersion, latestVersion)) {
    res.setHeader('Deprecation', 'true');
    
    // Add sunset header if configured
    if (sunsetDate && negotiatedVersion.startsWith('1.')) {
      res.setHeader('Sunset', sunsetDate);
    }
  }

  next();
}

/**
 * Determines if a version is considered deprecated.
 * A version is deprecated if it's older than the latest major version.
 */
function isDeprecatedVersion(version: string, latestVersion: string): boolean {
  const versionMajor = parseInt(version.split('.')[0], 10);
  const latestMajor = parseInt(latestVersion.split('.')[0], 10);
  
  return versionMajor < latestMajor;
}

/**
 * Parses a version string into comparable parts.
 * Returns [major, minor, patch] as numbers.
 */
export function parseVersion(version: string): [number, number, number] {
  const parts = version.split('.').map(p => parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Compares two version strings.
 * Returns -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2.
 */
export function compareVersions(v1: string, v2: string): number {
  const [major1, minor1, patch1] = parseVersion(v1);
  const [major2, minor2, patch2] = parseVersion(v2);

  if (major1 !== major2) return major1 < major2 ? -1 : 1;
  if (minor1 !== minor2) return minor1 < minor2 ? -1 : 1;
  if (patch1 !== patch2) return patch1 < patch2 ? -1 : 1;
  return 0;
}
