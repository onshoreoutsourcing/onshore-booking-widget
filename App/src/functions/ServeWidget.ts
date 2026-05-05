/**
 * GET /bookingwidget.js
 * GET /bookingwidget.css
 *
 * Serves the static widget bundle from the on-disk `static/` directory.
 * The bundle is produced by `npm run build:widget` (esbuild) and shipped
 * with the Functions App at deploy time.
 *
 * Why a function instead of Static Web Apps: keeping the widget and the
 * API endpoints in a single Functions App eliminates a second Azure
 * resource, a second deployment pipeline, and any cross-origin concerns
 * for the widget's own requests. See ADR-0002 in `Planning/decisions.md`.
 *
 * Caching: a versioned cache header is set so browsers and CDNs cache the
 * file for an hour. Each deploy bumps the byte content of the file, so
 * combined with the `Cache-Control: public, max-age=3600` and a deploy-
 * scoped ETag, browsers fetch new content within an hour of any deploy.
 *
 * Security: this endpoint serves only two specific filenames from the
 * static directory. There is no path traversal because the route is
 * matched against an exact-match pattern, not a wildcard.
 */

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface ServedFile {
  filename: string;
  contentType: string;
}

const SERVED_FILES: Record<string, ServedFile> = {
  bookingwidget_js: {
    filename: 'bookingwidget.js',
    contentType: 'application/javascript; charset=utf-8',
  },
  bookingwidget_css: {
    filename: 'bookingwidget.css',
    contentType: 'text/css; charset=utf-8',
  },
};

const CACHE_MAX_AGE_SECONDS = 3600; // 1 hour

// ---------------------------------------------------------------------------
// In-process file cache
// ---------------------------------------------------------------------------

interface CachedFile {
  content: Buffer;
  etag: string;
}

const fileCache: Map<string, CachedFile> = new Map();

/** Resolve the on-disk path to a static file. */
function resolveStaticPath(filename: string): string {
  // dist/src/functions/ServeWidget.js  →  dist/../static/<filename>  →  static/<filename>
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'static', filename);
}

async function readStaticFile(filename: string): Promise<CachedFile | null> {
  const cached = fileCache.get(filename);
  if (cached) {
    return cached;
  }

  const fsPath = resolveStaticPath(filename);
  try {
    await stat(fsPath); // surfaces a meaningful error if missing
  } catch {
    return null;
  }

  const content = await readFile(fsPath);
  const etag = `"${createHash('sha256').update(content).digest('hex').substring(0, 16)}"`;
  const entry: CachedFile = { content, etag };
  fileCache.set(filename, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.http('ServeWidgetJs', {
  methods: ['GET'],
  route: 'bookingwidget.js',
  authLevel: 'anonymous',
  handler: (request, context) =>
    serveStaticAsset(request, context, SERVED_FILES.bookingwidget_js),
});

app.http('ServeWidgetCss', {
  methods: ['GET'],
  route: 'bookingwidget.css',
  authLevel: 'anonymous',
  handler: (request, context) =>
    serveStaticAsset(request, context, SERVED_FILES.bookingwidget_css),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function serveStaticAsset(
  request: HttpRequest,
  context: InvocationContext,
  spec: ServedFile
): Promise<HttpResponseInit> {
  const file = await readStaticFile(spec.filename).catch((err) => {
    context.error(`[ServeWidget] failed to read ${spec.filename}:`, err);
    return null;
  });

  if (!file) {
    return {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body:
        `${spec.filename} is not available. ` +
        'Make sure `npm run build:widget` ran during deploy.',
    };
  }

  // 304 Not Modified support: lets browsers and CDNs revalidate cheaply.
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch === file.etag) {
    return {
      status: 304,
      headers: { ETag: file.etag },
    };
  }

  return {
    status: 200,
    headers: {
      'Content-Type': spec.contentType,
      'Cache-Control': `public, max-age=${CACHE_MAX_AGE_SECONDS}`,
      ETag: file.etag,
      // Static assets can be served to anyone — they contain no secrets
      // and no per-tenant data. The per-tenant validation happens in the
      // /api/slots and /api/bookings handlers when the widget calls them.
      'Access-Control-Allow-Origin': '*',
    },
    body: file.content,
  };
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Test-only: clears the in-process file cache. */
export function _resetFileCacheForTests(): void {
  fileCache.clear();
}
