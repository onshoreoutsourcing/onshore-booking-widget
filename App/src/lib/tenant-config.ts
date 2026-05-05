/**
 * Multi-tenant configuration.
 *
 * The Functions App serves multiple Microsoft Bookings businesses from a
 * single deployment. Configuration lives in the BOOKING_TENANTS App Setting
 * (a JSON array). Each tenant entry maps a public slug — the value site
 * owners place in the embed snippet's `data-tenant` attribute — to a
 * Microsoft Bookings business and the origins permitted to embed it.
 *
 * Rationale for the slug indirection: the widget never sees `businessId`,
 * site owners never type `businessId`. Slugs are short, URL-safe, durable
 * identifiers that are safe to expose in HTML.
 *
 * Configuration is parsed once per process and cached for the lifetime of
 * the Functions App instance. A deploy or App Service restart re-reads the
 * env var; that is the supported way to apply config changes.
 */

export interface TenantConfig {
  /** Public slug used in the embed snippet (e.g. "unified-support"). */
  readonly slug: string;
  /** Microsoft Bookings business mailbox (e.g. "Foo@example.com"). */
  readonly businessId: string;
  /** Microsoft Bookings service ID — a GUID under the business. */
  readonly serviceId: string;
  /** Human-readable name. Used in diagnostic logs only. */
  readonly label: string;
  /**
   * Origins permitted to embed this tenant's widget. Each entry is either an
   * exact origin (`https://example.com`) or `*` to allow any origin. Values
   * are compared with the request's `Origin` header (case-sensitive,
   * scheme + host + port).
   */
  readonly allowedOrigins: readonly string[];
}

let cachedTenants: readonly TenantConfig[] | null = null;

/**
 * Loads and validates the tenant configuration from the BOOKING_TENANTS
 * environment variable. Throws if the variable is missing, not valid JSON,
 * not an array, or contains entries with missing/invalid fields.
 *
 * Memoized: subsequent calls return the cached parse. Restart the Functions
 * App to re-read after an env-var change.
 */
export function loadTenants(): readonly TenantConfig[] {
  if (cachedTenants !== null) {
    return cachedTenants;
  }

  const raw = process.env.BOOKING_TENANTS;
  if (!raw || raw.trim() === '') {
    throw new Error(
      'BOOKING_TENANTS environment variable is not set. ' +
        'See local.settings.json.example for the expected schema.'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`BOOKING_TENANTS is not valid JSON: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('BOOKING_TENANTS must be a JSON array.');
  }

  if (parsed.length === 0) {
    throw new Error('BOOKING_TENANTS array is empty; configure at least one tenant.');
  }

  const tenants: TenantConfig[] = [];
  const seenSlugs = new Set<string>();

  for (const [index, entry] of parsed.entries()) {
    const tenant = validateEntry(entry, index);
    if (seenSlugs.has(tenant.slug)) {
      throw new Error(
        `BOOKING_TENANTS contains duplicate slug "${tenant.slug}". Slugs must be unique.`
      );
    }
    seenSlugs.add(tenant.slug);
    tenants.push(tenant);
  }

  cachedTenants = Object.freeze(tenants);
  return cachedTenants;
}

/**
 * Returns the tenant configuration matching the given slug, or null if no
 * tenant has that slug. Lookup is case-sensitive — slugs are URL-safe
 * identifiers and must match exactly.
 */
export function findTenantBySlug(slug: string): TenantConfig | null {
  if (!slug || typeof slug !== 'string') {
    return null;
  }
  return loadTenants().find((t) => t.slug === slug) ?? null;
}

/**
 * Returns true if the given origin is permitted to embed the given tenant's
 * widget. The empty/null origin is never permitted unless the tenant
 * explicitly allows `"*"`.
 *
 * Origin matching is exact (scheme + host + port). Subdomain wildcards are
 * not supported — list each subdomain explicitly.
 */
export function isOriginAllowed(tenant: TenantConfig, origin: string | null | undefined): boolean {
  if (tenant.allowedOrigins.includes('*')) {
    return true;
  }
  if (!origin) {
    return false;
  }
  return tenant.allowedOrigins.includes(origin);
}

/**
 * Returns the list of all configured slugs. Used for diagnostic logging
 * (e.g. when a request specifies an unknown slug, log the valid options
 * for the operator's benefit — visitors see only a generic 404).
 */
export function getAllSlugs(): readonly string[] {
  return loadTenants().map((t) => t.slug);
}

/**
 * Resets the in-process cache. Test-only. Production code clears the cache
 * via Functions App restart, not this function.
 */
export function _resetTenantCacheForTests(): void {
  cachedTenants = null;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateEntry(entry: unknown, index: number): TenantConfig {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`BOOKING_TENANTS[${index}] must be an object.`);
  }
  const obj = entry as Record<string, unknown>;

  const slug = requireString(obj, 'slug', index);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(slug)) {
    throw new Error(
      `BOOKING_TENANTS[${index}].slug "${slug}" is not URL-safe. ` +
        'Use letters, digits, and hyphens only; must start and end with a letter or digit.'
    );
  }

  const businessId = requireString(obj, 'businessId', index);
  const serviceId = requireString(obj, 'serviceId', index);
  const label = requireString(obj, 'label', index);

  const allowedOrigins = obj.allowedOrigins;
  if (!Array.isArray(allowedOrigins)) {
    throw new Error(`BOOKING_TENANTS[${index}].allowedOrigins must be an array.`);
  }
  if (allowedOrigins.length === 0) {
    throw new Error(
      `BOOKING_TENANTS[${index}].allowedOrigins is empty. ` +
        'Specify at least one allowed origin, or use ["*"] to allow any.'
    );
  }
  for (const [originIdx, origin] of allowedOrigins.entries()) {
    if (typeof origin !== 'string' || origin.length === 0) {
      throw new Error(
        `BOOKING_TENANTS[${index}].allowedOrigins[${originIdx}] must be a non-empty string.`
      );
    }
  }

  return Object.freeze({
    slug,
    businessId,
    serviceId,
    label,
    allowedOrigins: Object.freeze([...allowedOrigins]) as readonly string[],
  });
}

function requireString(obj: Record<string, unknown>, field: string, index: number): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`BOOKING_TENANTS[${index}].${field} is required and must be a non-empty string.`);
  }
  return value;
}
