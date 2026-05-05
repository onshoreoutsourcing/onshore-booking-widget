import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadTenants,
  findTenantBySlug,
  isOriginAllowed,
  getAllSlugs,
  _resetTenantCacheForTests,
  type TenantConfig,
} from '../src/lib/tenant-config.js';

const ORIGINAL_ENV = process.env.BOOKING_TENANTS;

function setTenants(tenants: unknown): void {
  if (tenants === undefined) {
    delete process.env.BOOKING_TENANTS;
  } else if (typeof tenants === 'string') {
    process.env.BOOKING_TENANTS = tenants;
  } else {
    process.env.BOOKING_TENANTS = JSON.stringify(tenants);
  }
  _resetTenantCacheForTests();
}

beforeEach(() => {
  _resetTenantCacheForTests();
});

afterEach(() => {
  if (ORIGINAL_ENV !== undefined) {
    process.env.BOOKING_TENANTS = ORIGINAL_ENV;
  } else {
    delete process.env.BOOKING_TENANTS;
  }
  _resetTenantCacheForTests();
});

// ---------------------------------------------------------------------------
// loadTenants — happy path
// ---------------------------------------------------------------------------

describe('loadTenants — happy path', () => {
  it('parses a single-tenant configuration', () => {
    setTenants([
      {
        slug: 'unified-support',
        businessId: 'UnifiedSupport@example.com',
        serviceId: '00000000-0000-0000-0000-000000000000',
        label: 'Unified Support',
        allowedOrigins: ['https://example.com'],
      },
    ]);
    const tenants = loadTenants();
    expect(tenants).toHaveLength(1);
    expect(tenants[0].slug).toBe('unified-support');
    expect(tenants[0].businessId).toBe('UnifiedSupport@example.com');
  });

  it('parses a multi-tenant configuration', () => {
    setTenants([
      {
        slug: 'a',
        businessId: 'A@example.com',
        serviceId: '00000000-0000-0000-0000-000000000001',
        label: 'A',
        allowedOrigins: ['https://a.example.com'],
      },
      {
        slug: 'b',
        businessId: 'B@example.com',
        serviceId: '00000000-0000-0000-0000-000000000002',
        label: 'B',
        allowedOrigins: ['https://b.example.com'],
      },
    ]);
    const tenants = loadTenants();
    expect(tenants).toHaveLength(2);
    expect(tenants[0].slug).toBe('a');
    expect(tenants[1].slug).toBe('b');
  });

  it('memoizes the parse result across calls', () => {
    setTenants([validTenant({ slug: 'memo' })]);
    const a = loadTenants();
    const b = loadTenants();
    expect(a).toBe(b); // same array reference
  });

  it('returns frozen tenant objects (defensive immutability)', () => {
    setTenants([validTenant({ slug: 'frozen' })]);
    const tenant = loadTenants()[0];
    expect(Object.isFrozen(tenant)).toBe(true);
    expect(Object.isFrozen(tenant.allowedOrigins)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadTenants — error cases
// ---------------------------------------------------------------------------

describe('loadTenants — error cases', () => {
  it('throws when BOOKING_TENANTS is unset', () => {
    setTenants(undefined);
    expect(() => loadTenants()).toThrow(/BOOKING_TENANTS .* not set/);
  });

  it('throws when BOOKING_TENANTS is the empty string', () => {
    setTenants('');
    expect(() => loadTenants()).toThrow(/not set/);
  });

  it('throws when BOOKING_TENANTS is invalid JSON', () => {
    setTenants('not-json');
    expect(() => loadTenants()).toThrow(/not valid JSON/);
  });

  it('throws when BOOKING_TENANTS is a JSON object (not array)', () => {
    setTenants(JSON.stringify({ slug: 'x' }));
    expect(() => loadTenants()).toThrow(/must be a JSON array/);
  });

  it('throws when the array is empty', () => {
    setTenants([]);
    expect(() => loadTenants()).toThrow(/array is empty/);
  });

  it('throws when an entry is missing slug', () => {
    setTenants([
      {
        businessId: 'X@example.com',
        serviceId: '00000000-0000-0000-0000-000000000000',
        label: 'X',
        allowedOrigins: ['https://x.com'],
      },
    ]);
    expect(() => loadTenants()).toThrow(/slug/);
  });

  it('throws when an entry is missing businessId', () => {
    setTenants([
      {
        slug: 'x',
        serviceId: '00000000-0000-0000-0000-000000000000',
        label: 'X',
        allowedOrigins: ['https://x.com'],
      },
    ]);
    expect(() => loadTenants()).toThrow(/businessId/);
  });

  it('throws when an entry is missing serviceId', () => {
    setTenants([
      {
        slug: 'x',
        businessId: 'X@example.com',
        label: 'X',
        allowedOrigins: ['https://x.com'],
      },
    ]);
    expect(() => loadTenants()).toThrow(/serviceId/);
  });

  it('throws when an entry has empty allowedOrigins', () => {
    setTenants([validTenant({ allowedOrigins: [] })]);
    expect(() => loadTenants()).toThrow(/allowedOrigins is empty/);
  });

  it('throws when allowedOrigins is not an array', () => {
    setTenants([
      {
        slug: 'x',
        businessId: 'X@example.com',
        serviceId: '00000000-0000-0000-0000-000000000000',
        label: 'X',
        allowedOrigins: 'https://x.com', // wrong: string instead of array
      },
    ]);
    expect(() => loadTenants()).toThrow(/must be an array/);
  });

  it('throws when slug contains invalid characters', () => {
    setTenants([validTenant({ slug: 'has spaces' })]);
    expect(() => loadTenants()).toThrow(/URL-safe/);
  });

  it('throws when slug starts with a hyphen', () => {
    setTenants([validTenant({ slug: '-leading-hyphen' })]);
    expect(() => loadTenants()).toThrow(/URL-safe/);
  });

  it('throws on duplicate slugs', () => {
    setTenants([
      validTenant({ slug: 'dup', businessId: 'A@example.com' }),
      validTenant({ slug: 'dup', businessId: 'B@example.com' }),
    ]);
    expect(() => loadTenants()).toThrow(/duplicate slug/);
  });
});

// ---------------------------------------------------------------------------
// findTenantBySlug
// ---------------------------------------------------------------------------

describe('findTenantBySlug', () => {
  beforeEach(() => {
    setTenants([
      validTenant({ slug: 'a' }),
      validTenant({ slug: 'b' }),
    ]);
  });

  it('returns the tenant for a known slug', () => {
    expect(findTenantBySlug('a')?.slug).toBe('a');
    expect(findTenantBySlug('b')?.slug).toBe('b');
  });

  it('returns null for an unknown slug', () => {
    expect(findTenantBySlug('c')).toBeNull();
  });

  it('is case-sensitive', () => {
    expect(findTenantBySlug('A')).toBeNull();
  });

  it('returns null for empty/null/undefined slug', () => {
    expect(findTenantBySlug('')).toBeNull();
    expect(findTenantBySlug(null as unknown as string)).toBeNull();
    expect(findTenantBySlug(undefined as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isOriginAllowed
// ---------------------------------------------------------------------------

describe('isOriginAllowed', () => {
  it('returns true for an exact match', () => {
    const tenant = validTenant({ allowedOrigins: ['https://example.com'] });
    expect(isOriginAllowed(tenant, 'https://example.com')).toBe(true);
  });

  it('returns false for a different scheme', () => {
    const tenant = validTenant({ allowedOrigins: ['https://example.com'] });
    expect(isOriginAllowed(tenant, 'http://example.com')).toBe(false);
  });

  it('returns false for a different host', () => {
    const tenant = validTenant({ allowedOrigins: ['https://example.com'] });
    expect(isOriginAllowed(tenant, 'https://example.org')).toBe(false);
  });

  it('returns false for a different port', () => {
    const tenant = validTenant({ allowedOrigins: ['https://example.com'] });
    expect(isOriginAllowed(tenant, 'https://example.com:8080')).toBe(false);
  });

  it('does not allow subdomain matches by default', () => {
    const tenant = validTenant({ allowedOrigins: ['https://example.com'] });
    expect(isOriginAllowed(tenant, 'https://www.example.com')).toBe(false);
    expect(isOriginAllowed(tenant, 'https://attacker.example.com')).toBe(false);
  });

  it('allows any origin when "*" is in the list', () => {
    const tenant = validTenant({ allowedOrigins: ['*'] });
    expect(isOriginAllowed(tenant, 'https://anywhere.com')).toBe(true);
    expect(isOriginAllowed(tenant, 'http://localhost:8080')).toBe(true);
  });

  it('"*" combined with explicit origins still wildcards everything', () => {
    const tenant = validTenant({ allowedOrigins: ['*', 'https://example.com'] });
    expect(isOriginAllowed(tenant, 'https://other.com')).toBe(true);
  });

  it('rejects null/undefined/empty origin unless wildcard is set', () => {
    const tenant = validTenant({ allowedOrigins: ['https://example.com'] });
    expect(isOriginAllowed(tenant, null)).toBe(false);
    expect(isOriginAllowed(tenant, undefined)).toBe(false);
    expect(isOriginAllowed(tenant, '')).toBe(false);
  });

  it('allows null/empty origin only if wildcard is set', () => {
    const tenant = validTenant({ allowedOrigins: ['*'] });
    expect(isOriginAllowed(tenant, null)).toBe(true);
    expect(isOriginAllowed(tenant, '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getAllSlugs
// ---------------------------------------------------------------------------

describe('getAllSlugs', () => {
  it('returns the slugs in declaration order', () => {
    setTenants([
      validTenant({ slug: 'first' }),
      validTenant({ slug: 'second' }),
      validTenant({ slug: 'third' }),
    ]);
    expect(getAllSlugs()).toEqual(['first', 'second', 'third']);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validTenant(overrides: Partial<TenantConfig> = {}): TenantConfig {
  const counter = (validTenant as unknown as { _n?: number })._n ?? 0;
  (validTenant as unknown as { _n?: number })._n = counter + 1;
  return {
    slug: `tenant-${counter}`,
    businessId: `Tenant${counter}@example.com`,
    serviceId: `00000000-0000-0000-0000-${String(counter).padStart(12, '0')}`,
    label: `Tenant ${counter}`,
    allowedOrigins: ['https://example.com'],
    ...overrides,
  };
}
