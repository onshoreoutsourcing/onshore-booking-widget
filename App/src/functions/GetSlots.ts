/**
 * GET /api/slots?tenant=<slug>
 *
 * Returns available booking slots for the specified tenant over the next
 * ~30 days. The tenant's General Availability schedule, lead time, and
 * max-advance window are applied.
 *
 * Request:
 *   GET /api/slots?tenant=unified-support
 *   Origin: https://onshoreunifiedsupport.com (validated against allowlist)
 *
 * Response (200):
 *   {
 *     "slots": {
 *       "2026-05-22": ["2026-05-22T14:00:00Z", "2026-05-22T14:30:00Z", ...],
 *       "2026-05-26": [...],
 *       ...
 *     }
 *   }
 *
 * Errors:
 *   400 — missing/invalid tenant query parameter
 *   403 — origin not allowed for this tenant
 *   404 — tenant slug not configured
 *   429 — per-IP rate limit exceeded
 *   503 — Microsoft Graph unavailable
 */

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { findTenantBySlug } from '../lib/tenant-config.js';
import { getAvailableSlots, GraphApiError } from '../lib/graph-client.js';
import { validateOrigin, checkRateLimit, getClientIp } from '../lib/bot-protection.js';

app.http('GetSlots', {
  methods: ['GET'],
  route: 'api/slots',
  authLevel: 'anonymous',
  handler: getSlotsHandler,
});

export async function getSlotsHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  // 1. Resolve tenant from the query parameter.
  const slug = request.query.get('tenant');
  if (!slug) {
    return jsonResponse(400, {
      error: 'missing_tenant',
      message: 'The "tenant" query parameter is required.',
    });
  }

  const tenant = findTenantBySlug(slug);
  if (!tenant) {
    return jsonResponse(404, {
      error: 'unknown_tenant',
      message: 'No booking configuration matches the requested tenant.',
    });
  }

  // 2. Validate the request's Origin against the tenant's allowlist.
  // Echo the validated Origin back in Access-Control-Allow-Origin so the
  // browser accepts the response. CORS preflight is handled by the
  // Functions platform; this header completes the per-tenant validation.
  if (!validateOrigin(tenant, request)) {
    context.warn(
      `[GetSlots] origin not allowed for tenant "${tenant.slug}":`,
      request.headers.get('origin') ?? '(none)'
    );
    return jsonResponse(403, {
      error: 'origin_not_allowed',
      message: 'This origin is not permitted to use the requested tenant.',
    });
  }

  // 3. Per-IP rate limit.
  const ip = getClientIp(request);
  const allowed = await checkRateLimit('slots', ip);
  if (!allowed) {
    return jsonResponse(
      429,
      {
        error: 'rate_limited',
        message: 'Too many requests. Please try again shortly.',
      },
      tenant.allowedOrigins.includes('*') ? '*' : request.headers.get('origin') ?? undefined
    );
  }

  // 4. Fetch slots from Microsoft Graph.
  try {
    const slots = await getAvailableSlots(tenant);
    return jsonResponse(
      200,
      { slots },
      tenant.allowedOrigins.includes('*') ? '*' : request.headers.get('origin') ?? undefined
    );
  } catch (err) {
    return handleGraphError(err, context, tenant.slug, request);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(
  status: number,
  body: unknown,
  allowOrigin?: string
): HttpResponseInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (allowOrigin) {
    headers['Access-Control-Allow-Origin'] = allowOrigin;
    headers['Vary'] = 'Origin';
  }
  return {
    status,
    headers,
    body: JSON.stringify(body),
  };
}

function handleGraphError(
  err: unknown,
  context: InvocationContext,
  slug: string,
  request: HttpRequest
): HttpResponseInit {
  const origin = request.headers.get('origin') ?? undefined;

  if (err instanceof GraphApiError) {
    context.error(
      `[GetSlots] Graph API error for tenant "${slug}" (status ${err.status}, code ${err.graphCode ?? 'unknown'}):`,
      err.message
    );
    return jsonResponse(
      503,
      {
        error: 'graph_unavailable',
        message: 'Unable to retrieve available times. Please try again.',
      },
      origin
    );
  }

  context.error(`[GetSlots] unexpected error for tenant "${slug}":`, err);
  return jsonResponse(
    500,
    {
      error: 'internal_error',
      message: 'An unexpected error occurred. Please try again.',
    },
    origin
  );
}
