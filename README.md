# Onshore Booking Widget

An embeddable Microsoft Bookings widget that runs on any website with two lines of HTML. Built as a single Azure Functions App that hosts both the widget code and the backend API. No client secrets, no Key Vault, no rotating credentials.

## What this is

A self-contained booking experience that replaces the iframe-based Microsoft Bookings widget with a fully branded, customizable form. It renders directly in the host page (no iframe), looks native to whatever site embeds it, and is portable across any platform that supports a `<script>` tag — WordPress, Wix, Squarespace, Shopify, plain HTML, React, Vue, partner microsites, etc.

The widget renders a 4-step flow:

1. **Date and Time** — calendar grid with available days highlighted, time slots in the visitor's local timezone
2. **Your Info** — contact form (first/last name, email; optional company/phone/notes)
3. **Confirm** — review summary
4. **Confirmed** — success screen with optional Microsoft Teams meeting link

Everything visible to visitors is rendered by the widget; the booking is created in Microsoft Bookings via Microsoft Graph.

## Why it exists

The previous Onshore booking experience was a Microsoft-hosted iframe embedded in a WordPress plugin (`simple-bookings`). That worked but had three problems:

- **WordPress-only.** Couldn't reuse the booking flow on other Onshore properties (Onshore IT Services, Lighthouse, partner microsites) without rebuilding the integration on each platform.
- **Brand discontinuity.** The iframe contents were Microsoft's UI, visibly different from the host site's design.
- **Operational coupling.** Schedule/availability changes required visiting both Microsoft Bookings and the WordPress plugin's settings.

This widget addresses all three: portable, fully branded, schedule lives only in Microsoft Bookings.

## Quick start (for site integrators)

Paste these two lines into any HTML page where the booking form should appear:

```html
<div id="booking-widget" data-tenant="<your-slug>"></div>
<script src="https://onshorebookings.azurewebsites.net/bookingwidget.js"></script>
```

That's the entire integration. The widget self-mounts into the `<div>` and starts loading available times.

The `data-tenant` value is a short identifier configured server-side that selects which Microsoft Bookings business this embed will book against. Ask the operator of the Functions App for your slug.

For complete integration help — including platform-specific examples (WordPress, Wix, Squarespace, React, etc.), CSS theming, troubleshooting, and a guide for using an LLM to assist with integration — see [`LLM_INSTRUCTIONS.md`](./LLM_INSTRUCTIONS.md).

## Architecture overview

```
Visitor's browser (any host site)
    │
    │ <script src="https://onshorebookings.azurewebsites.net/bookingwidget.js">
    │ widget self-mounts, fetches /api/slots and /api/bookings
    ▼
Azure Functions App (onshorebookings.azurewebsites.net)
    │
    │ GET /bookingwidget.js   → ServeWidgetJs   (static widget bundle)
    │ GET /bookingwidget.css  → ServeWidgetCss  (static styles)
    │ GET /api/slots          → GetSlots        (availability)
    │ POST /api/bookings      → CreateBooking   (create appointment)
    │
    │ Authentication: System-assigned Managed Identity (no client secret)
    ▼
Microsoft Graph API
    ├─ getStaffAvailability
    ├─ /bookingBusinesses/{id}
    └─ /appointments
```

A single Azure Functions App serves both the embeddable widget bundle and the API endpoints. The Functions App authenticates to Microsoft Graph using its system-assigned Managed Identity — no client secret stored anywhere. The widget loads and runs in the host page; the API talks to Microsoft Bookings.

Multi-tenant from day one: one Functions App deployment can serve multiple Microsoft Bookings businesses, with each host site selecting its property via the `data-tenant` slug.

## Tech stack

| Layer | Choice |
|---|---|
| Backend runtime | Azure Functions, Flex Consumption plan, Node 22 LTS |
| Backend language | TypeScript |
| Auth to Microsoft Graph | System-assigned Managed Identity (no rotating secrets) |
| Bot/abuse protection | CORS allowlist, honeypot field, time-to-submit guard, per-IP rate limiting (Azure Tables) |
| Widget bundle | Vanilla TypeScript bundled to a single IIFE via esbuild — no React/Vue/etc. dependency on the host page |
| CSS | Hand-authored vanilla CSS with custom properties for host-page theming |
| Tests | Vitest (unit tests for pure functions; integration tests via real deployment) |
| CI/CD | GitHub Actions with OIDC federated credentials (no Azure secrets in GitHub) |

## Repository layout

| Path | Contents |
|---|---|
| [`App/`](./App) | Azure Functions app — TypeScript source, build pipeline, tests |
| [`App/src/lib/`](./App/src/lib) | Shared library (Graph client, schedule logic, bot protection, tenant config) |
| [`App/src/functions/`](./App/src/functions) | HTTP-triggered Azure Functions |
| [`App/src/widget/`](./App/src/widget) | Browser-bound widget (TypeScript + CSS) bundled by esbuild |
| [`App/tests/`](./App/tests) | Unit tests |
| [`Planning/`](./Planning) | Architecture documents, ADR log, runbooks |
| [`Infra/`](./Infra) | Infrastructure-as-Code Bicep templates and runbooks (manual provisioning also supported) |
| [`Examples/`](./Examples) | Standalone test pages and embedding examples |
| [`.github/workflows/`](./.github/workflows) | CI/CD pipeline |
| [`LLM_INSTRUCTIONS.md`](./LLM_INSTRUCTIONS.md) | Self-contained integration guide for LLM-assisted embedding |

## Documentation

| Document | Audience | Purpose |
|---|---|---|
| [`LLM_INSTRUCTIONS.md`](./LLM_INSTRUCTIONS.md) | Site integrators | Paste into ChatGPT/Claude for guided integration on any platform |
| [`Planning/architecture.md`](./Planning/architecture.md) | Engineers, architects | Full design, rationale, and runtime flow |
| [`Planning/decisions.md`](./Planning/decisions.md) | Engineers | Architecture Decisions log (ADRs) — what was chosen, what was rejected, and why |
| [`Planning/cicd-setup.md`](./Planning/cicd-setup.md) | Operators | End-to-end runbook for setting up a new GitHub repo + Azure federated credentials + automated deployment |
| [`Infra/README.md`](./Infra/README.md) | Operators | Infrastructure provisioning (manual via Azure Portal, or via Bicep) |

## Development

### Prerequisites

- Node.js 22 LTS
- Azure Functions Core Tools v4 (for local function host)
- Azure CLI (for deployment auth setup)
- An Azure subscription with permissions to create a Function App, plus tenant admin or admin consent for Microsoft Graph application permissions

### Setup

```sh
git clone https://github.com/<your-org>/<this-repo>.git
cd <this-repo>/App
npm install
```

### Build

```sh
npm run build
```

This runs the widget bundler (esbuild → `static/bookingwidget.{js,css}`) and the TypeScript compiler (`tsc` → `dist/src/`).

### Run locally

Create `App/local.settings.json` from `App/local.settings.json.example` and fill in:

- `BOOKING_TENANTS` — JSON array of tenant configurations (see `Planning/architecture.md` for schema)
- `AZURE_TENANT_ID` — your Microsoft 365 tenant ID (only needed for local Graph auth via `az login` or service principal env vars)

Then:

```sh
npm run start
```

The Functions host runs on `http://localhost:7071`. The API endpoints become:

- `http://localhost:7071/api/slots?tenant=<slug>`
- `http://localhost:7071/api/bookings`
- `http://localhost:7071/bookingwidget.js`
- `http://localhost:7071/bookingwidget.css`

To exercise the widget end-to-end locally, point `Examples/embed-test.html`'s script src at `http://localhost:7071/bookingwidget.js` and serve the test page via any local web server (e.g., `npx http-server -p 8080`). Add `http://localhost:8080` to your test tenant's `allowedOrigins` list.

### Tests

```sh
npm test                # one-shot
npm run test:watch      # watch mode
npm run test -- --coverage   # with coverage
```

Unit tests cover the pure-function modules: `windows-tz`, `iso-duration`, `schedule`, `tenant-config`, and the helper functions in `bot-protection`. Integration tests exercise the deployed Function App against real Microsoft Graph; those run in production-adjacent staging.

### Type-check

```sh
npm run typecheck       # backend + widget
```

The backend uses `tsconfig.json`; the widget has its own `tsconfig.widget.json` because it targets the browser environment.

## Deployment

The repository ships with a GitHub Actions workflow ([`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)) that on every push to `main`:

1. Type-checks (backend + widget)
2. Runs unit tests
3. Builds the widget bundle and compiles TypeScript
4. Deploys to the Azure Functions App via OIDC federated credentials

For the one-time setup (creating the Functions App, configuring the federated credential, granting Microsoft Graph permissions), see [`Planning/cicd-setup.md`](./Planning/cicd-setup.md).

For manual deployment without GitHub Actions (Visual Studio Code, `func` CLI, or zip deploy), see [`Infra/README.md`](./Infra/README.md).

## Configuration

Runtime configuration lives in Azure App Settings on the Functions App. The single most important setting is `BOOKING_TENANTS`:

```json
[
  {
    "slug": "unified-support",
    "businessId": "OnshoreUnifiedSupport@onshoreoutsourcing.com",
    "serviceId": "<bookings-service-guid>",
    "label": "Onshore Unified Support",
    "allowedOrigins": ["https://onshoreunifiedsupport.com"]
  }
]
```

To add a new property (Onshore IT Services, Lighthouse, a partner site), append a tenant entry and restart the Functions App. No code change required. Full schema and examples in [`Planning/architecture.md`](./Planning/architecture.md).

## Status

Production-ready and in active deployment.

The widget is live at `https://onshorebookings.azurewebsites.net/bookingwidget.js` and currently serving the Onshore Unified Support property. The legacy Microsoft Bookings WordPress plugin (`simple-bookings`) remains deployed on the Onshore Unified Support site as the active embed; cutover from the WordPress plugin to this widget is planned once additional non-WordPress Onshore properties are ready to embed it.

## Contributing

Internal Onshore Outsourcing project. External contributions are not currently accepted.

## License

Proprietary. © Onshore Outsourcing. All rights reserved.

## Maintained by

[Onshore Outsourcing](https://onshoreoutsourcing.com) — US-based Microsoft technology services.
