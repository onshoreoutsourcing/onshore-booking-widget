/**
 * Tests for the pure-function helpers in bot-protection.
 *
 * The rate-limiting code paths require Azure Tables and are intentionally
 * excluded from this unit-test suite. They are validated by integration
 * tests against a real Storage Emulator (Azurite) or a deployed staging
 * environment, where the storage SDK can be exercised end-to-end.
 */

import { describe, it, expect } from 'vitest';
import type { HttpRequest } from '@azure/functions';
import {
  validateOrigin,
  checkHoneypot,
  checkTimeToSubmit,
  getClientIp,
} from '../src/lib/bot-protection.js';
import type { TenantConfig } from '../src/lib/tenant-config.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTenant(overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    slug: 'test',
    businessId: 'Test@example.com',
    serviceId: '00000000-0000-0000-0000-000000000000',
    label: 'Test',
    allowedOrigins: ['https://example.com'],
    ...overrides,
  };
}

/**
 * Builds a minimal HttpRequest stub. Only the `headers.get(name)` method is
 * exercised by the code under test; we provide a Map-backed implementation
 * that mimics the real Headers API closely enough.
 */
function makeRequest(headers: Record<string, string> = {}): HttpRequest {
  // Headers in Azure Functions v4 use a Headers-like API with case-insensitive
  // keys. The runtime delivers them lowercased.
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  return {
    headers: {
      get: (name: string): string | null => lower[name.toLowerCase()] ?? null,
    },
  } as unknown as HttpRequest;
}

// ---------------------------------------------------------------------------
// validateOrigin
// ---------------------------------------------------------------------------

describe('validateOrigin', () => {
  it('returns true when the request Origin matches the allowlist', () => {
    const tenant = makeTenant({ allowedOrigins: ['https://example.com'] });
    const req = makeRequest({ origin: 'https://example.com' });
    expect(validateOrigin(tenant, req)).toBe(true);
  });

  it('returns false when the request Origin is missing', () => {
    const tenant = makeTenant({ allowedOrigins: ['https://example.com'] });
    const req = makeRequest({});
    expect(validateOrigin(tenant, req)).toBe(false);
  });

  it('returns false when the request Origin is mismatched', () => {
    const tenant = makeTenant({ allowedOrigins: ['https://example.com'] });
    const req = makeRequest({ origin: 'https://attacker.com' });
    expect(validateOrigin(tenant, req)).toBe(false);
  });

  it('returns true for any origin when the tenant uses the wildcard', () => {
    const tenant = makeTenant({ allowedOrigins: ['*'] });
    expect(validateOrigin(tenant, makeRequest({ origin: 'https://anywhere.com' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkHoneypot
// ---------------------------------------------------------------------------

describe('checkHoneypot', () => {
  it('returns true when the website field is missing entirely', () => {
    expect(checkHoneypot({})).toBe(true);
  });

  it('returns true when the website field is an empty string', () => {
    expect(checkHoneypot({ website: '' })).toBe(true);
  });

  it('returns true when the website field is whitespace only', () => {
    expect(checkHoneypot({ website: '   ' })).toBe(true);
  });

  it('returns false when the website field is populated', () => {
    expect(checkHoneypot({ website: 'http://spam.example' })).toBe(false);
  });

  it('returns true when the website field is non-string (treated as absent)', () => {
    // The form has a string input; non-string values shouldn't happen in
    // practice, but defensive logic should not block the user.
    expect(checkHoneypot({ website: 123 })).toBe(true);
    expect(checkHoneypot({ website: null })).toBe(true);
    expect(checkHoneypot({ website: undefined })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkTimeToSubmit
// ---------------------------------------------------------------------------

describe('checkTimeToSubmit', () => {
  it('returns true when the elapsed time is well above the floor', () => {
    expect(checkTimeToSubmit({ formLoadedMs: 5000 })).toBe(true);
    expect(checkTimeToSubmit({ formLoadedMs: 60_000 })).toBe(true);
  });

  it('returns false when the elapsed time is below the 3-second floor', () => {
    expect(checkTimeToSubmit({ formLoadedMs: 100 })).toBe(false);
    expect(checkTimeToSubmit({ formLoadedMs: 2999 })).toBe(false);
  });

  it('returns true at exactly the floor', () => {
    expect(checkTimeToSubmit({ formLoadedMs: 3000 })).toBe(true);
  });

  it('returns true when the field is missing (backward compatibility)', () => {
    expect(checkTimeToSubmit({})).toBe(true);
  });

  it('returns true when the field is zero or negative (backward compatibility)', () => {
    expect(checkTimeToSubmit({ formLoadedMs: 0 })).toBe(true);
    expect(checkTimeToSubmit({ formLoadedMs: -1 })).toBe(true);
  });

  it('parses string-encoded numbers (some clients serialize as string)', () => {
    expect(checkTimeToSubmit({ formLoadedMs: '5000' })).toBe(true);
    expect(checkTimeToSubmit({ formLoadedMs: '100' })).toBe(false);
  });

  it('returns true when the value is unparseable (backward compatibility)', () => {
    expect(checkTimeToSubmit({ formLoadedMs: 'abc' })).toBe(true);
    expect(checkTimeToSubmit({ formLoadedMs: NaN })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getClientIp
// ---------------------------------------------------------------------------

describe('getClientIp', () => {
  it('returns the first IP from X-Forwarded-For', () => {
    const req = makeRequest({ 'x-forwarded-for': '1.2.3.4' });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('uses the leftmost IP when XFF has multiple values', () => {
    const req = makeRequest({
      'x-forwarded-for': '1.2.3.4, 10.0.0.1, 192.168.1.1',
    });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('strips a port from an IPv4 address', () => {
    const req = makeRequest({ 'x-forwarded-for': '1.2.3.4:5678' });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('strips a port from a bracketed IPv6 address', () => {
    const req = makeRequest({ 'x-forwarded-for': '[::1]:8080' });
    expect(getClientIp(req)).toBe('::1');
  });

  it('returns a bare IPv6 address unchanged (no port to strip)', () => {
    const req = makeRequest({
      'x-forwarded-for': '2001:db8:85a3::8a2e:370:7334',
    });
    expect(getClientIp(req)).toBe('2001:db8:85a3::8a2e:370:7334');
  });

  it('falls back to X-Real-IP when XFF is absent', () => {
    const req = makeRequest({ 'x-real-ip': '5.6.7.8' });
    expect(getClientIp(req)).toBe('5.6.7.8');
  });

  it('prefers XFF when both XFF and X-Real-IP are present', () => {
    const req = makeRequest({
      'x-forwarded-for': '1.2.3.4',
      'x-real-ip': '5.6.7.8',
    });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('returns "unknown" when no proxy header is present', () => {
    const req = makeRequest({});
    expect(getClientIp(req)).toBe('unknown');
  });

  it('returns "unknown" for an empty XFF', () => {
    // A header set to empty string should be treated as absent.
    const req = makeRequest({ 'x-forwarded-for': '' });
    expect(getClientIp(req)).toBe('unknown');
  });

  it('handles whitespace around values in XFF', () => {
    const req = makeRequest({ 'x-forwarded-for': '  1.2.3.4  , 10.0.0.1' });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });
});
