import { Request, Response, NextFunction } from 'express';
import { versioningMiddleware, parseVersion, compareVersions } from './versioning';
import { loadConfig } from '../../config';

// Mock Express request/response
const mockRequest = (headers: Record<string, string> = {}): Partial<Request> => ({
  headers: headers as any,
});

const mockResponse = (): Partial<Response> => {
  const res: Partial<Response> = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    locals: { apiVersion: undefined },
  };
  return res;
};

const mockNext: NextFunction = jest.fn();

describe('versioningMiddleware', () => {
  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();

    // Set default config for testing
    process.env.API_LATEST_VERSION = '2.0';
    process.env.API_SUPPORTED_VERSIONS = '1.0,1.1,2.0';
    process.env.API_DEFAULT_VERSION = '1.0';
    process.env.API_V1_SUNSET_DATE = '2024-12-31';

    // Reload config to pick up env changes
    loadConfig();
  });

  afterEach(() => {
    // Clean up env vars
    delete process.env.API_LATEST_VERSION;
    delete process.env.API_SUPPORTED_VERSIONS;
    delete process.env.API_DEFAULT_VERSION;
    delete process.env.API_V1_SUNSET_DATE;
  });

  it('should default to configured default version when API-Version header is omitted', () => {
    const req = mockRequest();
    const res = mockResponse();

    versioningMiddleware(req as Request, res as Response, mockNext);

    expect(res.locals?.apiVersion).toBe('1.0');
    expect(res.setHeader).toHaveBeenCalledWith('X-API-Version', '1.0');
    expect(res.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
    expect(res.setHeader).toHaveBeenCalledWith('Sunset', '2024-12-31');
    expect(mockNext).toHaveBeenCalled();
  });

  it('should use client-specified version when API-Version header is provided', () => {
    const req = mockRequest({ 'api-version': '1.1' });
    const res = mockResponse();
    
    versioningMiddleware(req as Request, res as Response, mockNext);
    
    expect(res.locals?.apiVersion).toBe('1.1');
    expect(res.setHeader).toHaveBeenCalledWith('X-API-Version', '1.1');
    expect(res.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
    expect(res.setHeader).toHaveBeenCalledWith('Sunset', '2024-12-31');
    expect(mockNext).toHaveBeenCalled();
  });

  it('should reject unsupported version with 400 error', () => {
    const req = mockRequest({ 'api-version': '3.0' });
    const res = mockResponse();
    
    versioningMiddleware(req as Request, res as Response, mockNext);
    
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: expect.stringContaining('Unsupported API version: "3.0"'),
        code: 'UNSUPPORTED_API_VERSION',
        supportedVersions: ['1.0', '1.1', '2.0'],
      },
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should reject invalid version format with 400 error', () => {
    const req = mockRequest({ 'api-version': 'invalid' });
    const res = mockResponse();
    
    versioningMiddleware(req as Request, res as Response, mockNext);
    
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: expect.stringContaining('Unsupported API version: "invalid"'),
        code: 'UNSUPPORTED_API_VERSION',
        supportedVersions: ['1.0', '1.1', '2.0'],
      },
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should add deprecation headers for v1.x versions', () => {
    const req = mockRequest({ 'api-version': '1.0' });
    const res = mockResponse();
    
    versioningMiddleware(req as Request, res as Response, mockNext);
    
    expect(res.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
    expect(res.setHeader).toHaveBeenCalledWith('Sunset', '2024-12-31');
  });

  it('should not add deprecation headers for latest version', () => {
    const req = mockRequest({ 'api-version': '2.0' });
    const res = mockResponse();
    
    versioningMiddleware(req as Request, res as Response, mockNext);
    
    expect(res.setHeader).toHaveBeenCalledWith('X-API-Version', '2.0');
    expect(res.setHeader).not.toHaveBeenCalledWith('Deprecation', 'true');
  });

  it('should handle missing sunset date gracefully', () => {
    delete process.env.API_V1_SUNSET_DATE;
    loadConfig();

    const req = mockRequest({ 'api-version': '1.0' });
    const res = mockResponse();

    versioningMiddleware(req as Request, res as Response, mockNext);

    expect(res.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
    expect(res.setHeader).not.toHaveBeenCalledWith('Sunset', expect.any(String));
  });

  it('should use configured default version when set to 2.0', () => {
    process.env.API_DEFAULT_VERSION = '2.0';
    loadConfig();

    const req = mockRequest();
    const res = mockResponse();

    versioningMiddleware(req as Request, res as Response, mockNext);

    expect(res.locals?.apiVersion).toBe('2.0');
    expect(res.setHeader).toHaveBeenCalledWith('X-API-Version', '2.0');
    expect(res.setHeader).not.toHaveBeenCalledWith('Deprecation', 'true');
    expect(mockNext).toHaveBeenCalled();
  });
});

describe('parseVersion', () => {
  it('should parse version string into components', () => {
    expect(parseVersion('1.0.0')).toEqual([1, 0, 0]);
    expect(parseVersion('2.1')).toEqual([2, 1, 0]);
    expect(parseVersion('3')).toEqual([3, 0, 0]);
  });

  it('should handle malformed versions gracefully', () => {
    expect(parseVersion('invalid')).toEqual([0, 0, 0]);
    expect(parseVersion('')).toEqual([0, 0, 0]);
  });
});

describe('compareVersions', () => {
  it('should return -1 when v1 < v2', () => {
    expect(compareVersions('1.0', '2.0')).toBe(-1);
    expect(compareVersions('1.1', '1.2')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
  });

  it('should return 0 when v1 == v2', () => {
    expect(compareVersions('1.0', '1.0')).toBe(0);
    expect(compareVersions('2.1.0', '2.1')).toBe(0);
  });

  it('should return 1 when v1 > v2', () => {
    expect(compareVersions('2.0', '1.0')).toBe(1);
    expect(compareVersions('1.2', '1.1')).toBe(1);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
  });
});
