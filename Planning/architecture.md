# Architecture

## Goal

Provide a Microsoft Bookings booking experience that can be embedded on any website — WordPress, Wix, Squarespace, plain HTML, React app, partner microsites — with a two-line HTML snippet. Replace the WordPress-only `simple-bookings` plugin with a portable architecture that does not require a host site to run any specific CMS.

## Architecture summary

A single **Azure Functions App** (`onshorebookings`) that serves both the embeddable widget script and the backend API endpoints. The Functions App authenticates to Microsoft Graph via its **system-assigned Managed Identity** — no client secret, no Key Vault, no rotating credentials. The app talks to Microsoft Graph to fetch availability and create appointments, and serves the widget bundle for any host site to embed.

Initial host: `https://onshorebookings.azurewebsites.net` (the default Azure-assigned URL). A custom domain may be bound later.

```
Visitor's browser (any host site)
    |
    | <script src="https://onshorebookings.azurewebsites.net/bookingwidget.js">
    | widget mounts itself into <div id="booking-widget" data-tenant="...">
    | widget calls /api/slots and /api/bookings (with tenant slug)
    |
    v
Azure Functions App (onshorebookings.azurewebsites.net)
    ├─ ServeWidget    GET /bookingwidget.js, /bookingwidget.css
    ├─ GetSlots       GET /api/slots
    └─ CreateBooking  POST /api/bookings
        |
        | System-assigned Managed Identity
        | (acquires bearer token via @azure/identity)
        v
Microsoft Graph API
    ├─ getStaffAvailability
    ├─ /bookingBusinesses/{id}
    └─ /appointments
```

There are **no secrets to rotate**. Graph application permissions are granted to the Managed Identity once at provisioning time; tenant ID and business ID are public identifiers stored as plain App Settings.

## Why this shape

### Why Azure Functions

- Scales to zero when idle, scales out elastically during traffic bursts.
- No infrastructure to patch (Microsoft owns the runtime).
- Native to the existing Onshore Azure tenant (same RBAC, monitoring, billing).
- Cost is essentially free at booking-form volume (~$0–5/month).
- Cold-start penalty (~300–500 ms first hit) is acceptable for a booking widget.

### Why a single Functions App (and not a Static Web App + Functions split)

- One Azure resource to provision, deploy, monitor, secure, and bill.
- One CI/CD pipeline. One App Settings page. One log stream.
- Same-origin by definition — the widget loads from `onshorebookings.azurewebsites.net` and calls `onshorebookings.azurewebsites.net/api/*`, so the widget's own requests carry no CORS preflight overhead.
- Widget and API ship together, so version coupling is automatic.
- The trade-off vs Static Web App (no built-in CDN, no automatic Brotli compression on static files) is invisible at expected volume.

### Why Managed Identity for Microsoft Graph (and no Key Vault)

- **Zero secrets to rotate.** The `client_secret` of the previous design is eliminated outright; Managed Identity tokens are acquired and refreshed by Azure transparently.
- **Smaller infrastructure footprint.** No Key Vault resource, no Key Vault SDK dependency, no Key Vault role assignments. One less thing to provision, monitor, and document.
- **Best-practice security posture.** Managed Identity is Microsoft's recommended pattern for service-to-service auth within Azure; the client-credentials-with-secret flow is the legacy fallback.
- **Tenant ID and business ID are not secrets.** They're public identifiers — tenant IDs appear in OAuth flows visible to browsers, business IDs are the public mailbox names that visitors see in calendar invites. They live as plain App Settings.

The one-time cost: granting Microsoft Graph application permissions (`BookingsAppointment.ReadWrite.All`, etc.) to the Managed Identity requires a PowerShell or Microsoft Graph API call rather than a portal click. The procedure is captured in `Infra/scripts/grant-graph-permissions.ps1` and run once per environment.

### Why Node 22 LTS

- LTS support extends to April 2027 — comfortable runway past the typical Functions runtime upgrade cadence.
- Faster cold starts than .NET (~300 ms vs ~1–2 s).
- One language across the entire stack (backend + widget), no PHP/JS context switching.
- First-class `fetch`, `crypto.subtle`, and `AbortController` in the runtime — no polyfills.
- Strong Microsoft Graph SDK support if needed later (we use raw `fetch` for parity with the existing PHP implementation).

## Components

### Functions App (`App/`)

Three HTTP-triggered functions:

| Function | Method | Route | Purpose |
|---|---|---|---|
| `ServeWidget` | GET | `/bookingwidget.{js,css}` | Returns the static widget files with proper content-type and cache headers |
| `GetSlots` | GET | `/api/slots` | Fetches Microsoft Graph availability, applies the General Availability schedule filter, returns date-keyed slot map |
| `CreateBooking` | POST | `/api/bookings` | Validates bot-protection layers, creates a Microsoft Bookings appointment, returns confirmation |

Shared library code under `App/src/lib/`:

| Module | Purpose |
|---|---|
| `graph-client.ts` | Microsoft Graph token acquisition (via Managed Identity), raw API calls, slot generation. Algorithmic port of the PHP plugin's `class-graph-client.php`; auth flow simplified. |
| `schedule.ts` | Parse Bookings General Availability, evaluate whether a slot falls inside the configured schedule. |
| `windows-tz.ts` | Windows-to-IANA timezone mapping (Bookings returns "Eastern Standard Time"; PHP/JS need "America/New_York"). |
| `iso-duration.ts` | Parse ISO 8601 duration strings (`PT30M`, `P1D`, `P60D`) to seconds. |
| `bot-protection.ts` | Honeypot, time-to-submit guard, per-IP rate limiting via Azure Tables. |

### Widget bundle (`App/src/widget/`)

| File | Purpose |
|---|---|
| `bookingwidget.ts` | Self-mounting client-side code adapted from the WordPress plugin's `booking-form.js`. Renders the calendar + slot picker + contact form + confirmation flow. |
| `bookingwidget.css` | Visual styling. CSS custom properties allow host pages to override colors and fonts. |

Build pipeline (esbuild) produces minified `bookingwidget.js` and `bookingwidget.css`, copied into `App/static/` so `ServeWidget` can read them at request time.

### Infrastructure (`Infra/`)

Bicep templates that provision the Azure resources:

| Resource | Purpose |
|---|---|
| Resource Group | Container for all booking-related resources |
| Storage Account | Required by Functions runtime; also hosts the Tables used for rate-limiting |
| Functions App (Linux, Consumption plan, Node 22) | The compute |
| App Service Plan | Consumption-plan reference |
| System-assigned Managed Identity | Granted Microsoft Graph application permissions; acquires tokens transparently |
| Application Insights | Telemetry and log aggregation |
| Custom domain binding *(future)* | An Onshore-owned domain (e.g. `booking.onshore.com`) bound to the Functions App with an Azure-managed TLS certificate. Not part of Phase 1; the default `*.azurewebsites.net` URL is sufficient for the initial deployment. |

**No Key Vault.** No Azure AD app registration with a client secret. No HSM-backed secrets storage of any kind.

## Bot and spam protection

Three layers, deliberately scoped to defense-in-depth without a stateful CSRF token:

1. **CORS** — Functions App allowlists the origins permitted to embed the widget. Browser-enforced; the first line of defense. For a public booking widget, an `*` allowlist is acceptable when paired with the layers below.
2. **Honeypot field** — hidden `website` input. Bots populate it; the server silently drops those submissions and returns success so the detection method is not revealed.
3. **Time-to-submit guard** — widget records a script-init timestamp and sends elapsed milliseconds; submissions under 3 seconds are silently dropped.
4. **Per-IP rate limiting** — 5 bookings/min, 30 slot lookups/min. Counters stored in Azure Tables, keyed by `{action, hash(ip)}`.

A traditional CSRF token was considered and rejected: the booking endpoint has no authenticated users, no session state to abuse, and no privilege to escalate (anyone with the URL can submit anyway). The four layers above match the protection posture of comparable embedded booking widgets (Calendly, Cal.com, HubSpot Meetings) without introducing a cryptographic secret that would itself need to be managed.

## Caching strategy

Two caches, all in-process to the Functions App (cleared on cold-start, cleared on deploy):

| Cache | TTL | Purpose |
|---|---|---|
| Microsoft Graph access token | Refreshed automatically by `@azure/identity` | Token acquisition cost is amortized by the SDK; we don't manage it ourselves |
| Bookings staff IDs | 1 hour | `getStaffAvailability` requires staff IDs; fetch them once and reuse |
| Bookings business schedule | 1 hour | The General Availability schedule + scheduling policy parameters |

In-process caching is sufficient for the expected volume. If a deploy or restart clears a cache, the next request rehydrates it (~200–500 ms first hit).

A clear-cache mechanism (an admin HTTP-triggered function with shared-secret authorization, or a manual App Service restart) lets operators force a rehydration when Bookings configuration changes need to apply immediately.

## Multi-tenant configuration

The system is multi-tenant from Phase 1: a single Functions App deployment can serve multiple Microsoft Bookings businesses, with each host site selecting its property via a slug in the embed snippet.

**Embed snippet:**

```html
<div id="booking-widget" data-tenant="unified-support"></div>
<script src="https://onshorebookings.azurewebsites.net/bookingwidget.js"></script>
```

**Configuration** lives in a single `BOOKING_TENANTS` App Setting (a JSON array). Each entry maps a public slug to a Bookings business, a service ID under that business, and the origins permitted to embed it:

```json
[
  {
    "slug": "unified-support",
    "businessId": "OnshoreUnifiedSupport@onshoreoutsourcing.com",
    "serviceId": "2119a826-85ee-43d9-9621-d0e8e3c0f9f2",
    "label": "Onshore Unified Support",
    "allowedOrigins": ["https://onshoreunifiedsupport.com"]
  },
  {
    "slug": "it-services",
    "businessId": "OnshoreITServices@onshoreoutsourcing.com",
    "serviceId": "00000000-0000-0000-0000-000000000000",
    "label": "Onshore IT Services",
    "allowedOrigins": ["https://onshoreitservices.com"]
  }
]
```

The `serviceId` is the GUID of a Microsoft Bookings service under the business — Bookings supports multiple services per business (e.g., "30-Minute Discovery Call" vs "60-Minute Deep Dive"). Each tenant binds to one. To find a service ID, query `GET /solutions/bookingBusinesses/{businessId}/services` against Microsoft Graph; the response includes the GUIDs.

**Runtime behavior:**

1. Widget reads `data-tenant` from the mount element (the `<div id="booking-widget">`).
2. Widget includes `tenant=<slug>` in `/api/slots` and `/api/bookings` requests.
3. Backend looks up the slug in `BOOKING_TENANTS`. Unknown slug → 404.
4. Backend validates the request's `Origin` header against the tenant's `allowedOrigins`. Mismatch → 403.
5. Backend uses the tenant's `businessId` for all Microsoft Graph calls.
6. Cache keys include the slug to prevent cross-tenant cache pollution.

The widget code never sees `businessId`. Site owners never type `businessId`. To add a new property, append a tenant entry to `BOOKING_TENANTS` and restart the Functions App. No code change required.

## App Settings

All values are non-secret configuration. None of them require Key Vault references.

| Setting | Example value | Purpose |
|---|---|---|
| `BOOKING_TENANTS` | (JSON array — see above) | Multi-tenant configuration |
| `AzureWebJobsStorage` | (managed by deploy) | Required by Functions runtime |
| `FUNCTIONS_WORKER_RUNTIME` | `node` | Functions config |
| `FUNCTIONS_EXTENSION_VERSION` | `~4` | Functions config |
| `AZURE_TENANT_ID` *(optional, local dev only)* | `00000000-0000-0000-0000-000000000000` | M365 tenant for `DefaultAzureCredential` when running outside Azure. Not needed in production (Managed Identity supplies its own tenant context). |

## Deployment

GitHub Actions workflow on push to `main`:

1. Install dependencies (`npm ci`)
2. Build the widget (`esbuild`)
3. Compile TypeScript (`tsc`)
4. Run tests (Vitest)
5. Deploy to Azure Functions App via `Azure/functions-action@v1`

Service principal credentials in GitHub repository secrets — these are needed only for deploy and are scoped to the resource group. No Microsoft Graph credentials are stored in GitHub (none exist; the Managed Identity acquires them at runtime).

A `staging` deployment slot lets pre-production validation happen on real Azure infrastructure before swap-to-production.

## Migration from the WordPress plugin

Phased approach to minimize risk:

1. Build the Functions stack in parallel with the existing WordPress plugin.
2. Validate end-to-end on a private test page before touching production.
3. Embed on a second Onshore property (Onshore IT Services, Lighthouse, or test site) as the actual first production deployment.
4. Eventually migrate the Onshore Unified Support site itself: the WordPress plugin is reduced to ~20 lines that render the embed snippet, or removed entirely in favor of editing the page template directly.
5. Decommission the plugin once everything is migrated.

The existing WordPress booking experience never breaks during the build.

## Future extensions (out of scope for Phase 1)

| Extension | Effort to add later |
|---|---|
| Custom domain binding | ~30 minutes once a domain is chosen and DNS access is available |
| iframe variant alongside the widget | ~50 lines of additional code; same backend |
| Customer-facing reschedule/cancel | ~8 hours; new endpoints + email lookup |
| Multi-service support | ~6 hours; service-picker step in the widget |
| White-labeled embedding | The architecture supports this without redesign |
| Cross-Microsoft-tenant SaaS | Significant; requires per-tenant Managed Identity strategy |

## Open questions

These are tracked in `decisions.md` and locked in before the relevant code is written:

1. ~~Canonical domain name~~ — initial URL is `onshorebookings.azurewebsites.net`; custom domain deferred to Phase 2 (ADR-0008).
2. ~~Single-tenant vs multi-tenant~~ — multi-tenant from day one (ADR-0012, supersedes ADR-0005).
3. ~~Microsoft Graph auth strategy~~ — Managed Identity (ADR-0009, supersedes ADR-0006).
4. ~~Repository strategy~~ — standalone GitHub repo (ADR-0013).
5. First non-WordPress deployment target — not required to begin the build; resolves when launch planning starts.
6. Cutover timing for the existing WordPress plugin — not required to begin the build; resolves once the new stack is validated.
