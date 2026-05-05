# Architecture Decisions Log

Running log of architectural decisions for the booking widget project. Each entry captures the choice, the alternatives considered, and the rationale. Append new entries; never edit historical ones (revise via a new entry that supersedes).

---

## ADR-0001: Replace WordPress plugin with portable Azure Functions architecture

**Date:** 2026-05-04
**Status:** Accepted

**Context.** The current `simple-bookings` WordPress plugin only works on WordPress. Onshore wants the booking experience available on multiple owned properties (Onshore IT Services, Lighthouse, partner microsites) without rebuilding it for each platform.

**Decision.** Build a portable widget hosted on Onshore-owned Azure infrastructure that any website can embed via a two-line HTML snippet. The widget loads from a stable URL; the host site does not host any code.

**Alternatives.**
- *Keep the WordPress plugin.* Forecloses non-WordPress deployment.
- *Iframe to the existing WordPress site.* Cheapest in the short term; defers rather than solves the architecture question; aesthetic and CSP issues on host sites.
- *SaaS multi-tenant booking middleware.* Right idea, wrong scope — much larger effort, real product business commitment.

**Consequences.** Replaces a one-resource WordPress plugin with a small Azure footprint. Adds operational surface (a Functions App, a Key Vault, a Storage Account) but eliminates platform lock-in. Existing WordPress booking continues running in parallel during the build; cutover is phased.

---

## ADR-0002: Single Functions App that serves both widget and API

**Date:** 2026-05-04
**Status:** Accepted

**Context.** Two reasonable shapes were considered: (a) a Static Web App for the widget files plus a Functions App for the API, with the auto-bound `/api` proxy, and (b) a single Functions App that serves both.

**Decision.** Single Functions App. Three HTTP-triggered functions: `ServeWidget`, `GetSlots`, `CreateBooking`.

**Alternatives.**
- *Static Web App + Functions App split.* Cleaner separation of concerns; gets free CDN + Brotli compression on static files; doubles the operational surface (two resources, two deployments, two CORS configurations).
- *Single function with wildcard routing.* Even more compact but less idiomatic; harder telemetry filtering.

**Rationale.** The visible benefits of a Static Web App (CDN, edge caching, Brotli) only matter at high traffic volumes. The cost of operational duplication is paid every day from launch. The single-app variant is simpler and cheaper for the realistic Onshore volume.

**Consequences.** Cold-start penalty (~300–500 ms) applies to widget file requests too, not just API requests. Acceptable at expected volume. If it ever becomes annoying, splitting the static files out to a CDN later is straightforward and doesn't require backend changes.

---

## ADR-0003: TypeScript on Node 20 runtime

**Date:** 2026-05-04
**Status:** Superseded by ADR-0010 (2026-05-05)

**Context.** Functions supports several runtimes (.NET, Java, Python, PowerShell, Node). The widget code is JavaScript by definition.

**Decision.** TypeScript compiled to Node 20 for the Functions runtime; TypeScript for the widget source, transpiled and minified by esbuild for browser delivery.

**Alternatives.**
- *.NET (C#).* More verbose; cold start ~3× slower; no shared language with widget.
- *Python.* Slower cold start than Node; weaker Microsoft Graph SDK ecosystem; no shared language with widget.
- *PHP on a custom worker.* Closest to the existing plugin code but not a first-class Functions runtime.
- *Plain JavaScript (no TypeScript).* Faster to write initially; lose static typing benefits, especially for the Graph response shapes.

**Rationale.** One language across the stack keeps mental overhead low. TypeScript catches the obvious mistakes (especially around Graph API response shapes) at compile time. Node's cold start is the fastest of the supported runtimes.

**Consequences.** Adds a build step (esbuild + tsc) but the build is fast and well-understood. CI/CD complexity is minimal.

---

## ADR-0004: Raw `fetch` for Microsoft Graph (not the SDK)

**Date:** 2026-05-04
**Status:** Accepted

**Context.** Microsoft publishes `@microsoft/microsoft-graph-client` for Node, which provides typed access to Graph endpoints with built-in pagination, retry, and auth helpers.

**Decision.** Use raw `fetch` calls against documented Graph URLs, mirroring the approach taken in the existing PHP plugin's `class-graph-client.php`.

**Alternatives.**
- *`@microsoft/microsoft-graph-client` SDK.* Cleaner code, typed responses; ~600 KB dependency; slower cold start; opinionated about auth flow.
- *Custom thin wrapper using a smaller HTTP library.* No clear benefit over `fetch` (which is built into Node 20).

**Rationale.** The existing PHP plugin uses raw HTTP calls and has been stable for ~12 versions. Carrying that pattern over makes the port mechanical. Avoiding the SDK keeps cold-start cost down. The Bookings endpoints we touch are stable and well-documented.

**Consequences.** We define our own TypeScript types for Graph response shapes (~50 lines). If Bookings adds new fields we don't consume, we ignore them; if Bookings changes existing field shapes, we adapt our types.

---

## ADR-0005: Single-tenant for Phase 1 (one Bookings business)

**Date:** 2026-05-04
**Status:** Superseded by ADR-0012 (2026-05-05)

**Context.** The plugin today is hardcoded to one Microsoft Bookings business via env vars. The new architecture could either preserve that (one business globally) or accept a `data-business-id` from the embed snippet and look up per-tenant credentials per request.

**Decision.** Single-tenant for Phase 1, multi-tenant deferred to Phase 2.

**Alternatives.**
- *Multi-tenant from day one.* Adds ~4–8 hours; defers no work; introduces a credential-lookup layer that must work correctly before any deployment is useful.

**Rationale.** Matches existing plugin behavior, lets the first production deployment succeed sooner, doesn't preclude the multi-tenant extension later. The single-tenant code paths are essentially unchanged in a multi-tenant world — credentials lookup just becomes parameterized.

**Consequences.** First deployment serves only the Onshore Unified Support Bookings business. To add Onshore IT Services or Lighthouse with separate Bookings businesses, Phase 2 multi-tenant work must land first.

**Supersedes/Superseded by:** N/A.

---

## ADR-0006: Microsoft Graph auth via existing Azure AD app + client secret (Phase 1)

**Date:** 2026-05-04
**Status:** Superseded by ADR-0009 (2026-05-05)

**Context.** Microsoft Graph supports two auth flows for daemon apps: client-credentials (app + secret), and Managed Identity (the Functions App's identity is granted Graph permissions directly).

**Decision.** Phase 1 keeps the existing Azure AD app + client secret stored in Key Vault. Migrating to Managed Identity for Graph is a Phase 2 polish.

**Alternatives.**
- *Managed Identity for Graph from day one.* Eliminates the client secret entirely; cleaner security posture; requires PowerShell/Graph admin work to assign the Graph application roles to the managed identity (`BookingsAppointment.ReadWrite.All`, etc.); no functional difference in Phase 1.

**Rationale.** The existing app already has the right permissions (resolved during the original plugin's auth diagnostic in early 2026). Reusing it accelerates Phase 1 without leaving anything fragile. The Managed Identity migration is purely cosmetic and can land anytime later.

**Consequences.** A client secret continues to exist in Key Vault and must be rotated periodically (recommended every 90–180 days). The rotation procedure is documented in the runbook.

**Supersedes/Superseded by:** N/A. Will be superseded by an ADR adopting Managed Identity for Graph in Phase 2.

---

## ADR-0007: Stateless HMAC-signed CSRF tokens (replacing WordPress nonces)

**Date:** 2026-05-04
**Status:** Superseded by ADR-0011 (2026-05-05)

**Context.** The WordPress plugin uses `wp_create_nonce()` / `wp_verify_nonce()` to prevent cross-site form submission. That mechanism relies on WordPress sessions and won't translate to a stateless Functions environment. Even if it did, third-party cookie restrictions in modern browsers (especially Safari ITP) would compromise it for iframe-embedded variants in the future.

**Decision.** Replace the WordPress nonce with an HMAC-signed token. The token is generated server-side at widget load (or on-demand via a `/api/csrf` endpoint), signed with a server-side secret, and validated on `CreateBooking`. The token includes a timestamp and short expiration.

**Alternatives.**
- *Cookie-based session token.* Breaks under third-party cookie restrictions in iframe contexts.
- *No CSRF protection.* Acceptable for low-value endpoints; not appropriate for one that creates calendar appointments and sends meeting invites.

**Rationale.** Stateless tokens work identically for direct visits, widget embeds, and (future) iframe embeds. They survive third-party cookie restrictions. They scale naturally across Functions cold starts.

**Consequences.** A dedicated HMAC secret must be generated, stored in Key Vault, and rotated periodically. Token expiration (~30 minutes) means visitors who leave the booking form open for too long need to refresh — acceptable trade-off.

---

## ADR-0008: Use the default Azure-assigned URL for Phase 1; defer custom domain

**Date:** 2026-05-05
**Status:** Accepted

**Context.** The widget host URL goes into every embed snippet, every CORS allowlist, and every doc. A custom domain (`booking.onshore.com`, `booking.onshoreunifiedsupport.com`, etc.) requires DNS access, a TLS certificate, and a custom-domain binding on the Functions App. None of this is hard, but it adds setup time and is reversible later.

**Decision.** Phase 1 uses the default Azure-assigned URL: `https://onshorebookings.azurewebsites.net`. The Functions App is named `onshorebookings`, which produces this hostname automatically. A custom domain may be added in Phase 2 once the architecture is validated and a domain is chosen.

**Alternatives.**
- *Pick a custom domain now (`booking.onshore.com`).* Forces a DNS + TLS setup before the first deployment can be tested.
- *Pick a subdomain of the existing site (`booking.onshoreunifiedsupport.com`).* Workable, but ties the booking infrastructure visually to the Unified Support brand even when it serves Onshore IT Services or Lighthouse later.

**Rationale.** `*.azurewebsites.net` is a valid HTTPS host with a Microsoft-managed TLS certificate from day one. It works identically to a custom domain for the widget's purposes. Migrating to a custom domain later is a ~30-minute task: update the embed snippet, add the custom domain to the Functions App, update CORS, and let the WordPress site / partner sites update their snippet at their own pace.

**Consequences.** The embed snippet ships as `<script src="https://onshorebookings.azurewebsites.net/bookingwidget.js"></script>`. Site owners who embed it will see this hostname; the brand visibility is "Microsoft Azure," not "Onshore." Acceptable for Phase 1 internal validation. The custom-domain swap in Phase 2 will require a coordinated update of all embed snippets across host sites — manageable while the host-site count is small.

---

## ADR-0009: Microsoft Graph auth via Managed Identity (no Key Vault, no client secret)

**Date:** 2026-05-05
**Status:** Accepted (supersedes ADR-0006)

**Context.** ADR-0006 proposed reusing the existing Azure AD app registration with a client secret stored in Key Vault. The owner indicated a preference for an architecture without rotating secrets.

**Decision.** Use the Functions App's system-assigned Managed Identity to authenticate to Microsoft Graph. Grant the Managed Identity the same Microsoft Graph application permissions that the existing app registration holds (`BookingsAppointment.ReadWrite.All` and any others required by the booking flow). Eliminate Key Vault entirely.

**Alternatives.**
- *Existing client-credentials flow with secret in Key Vault.* Works, but introduces a 90–180 day rotation cadence and a Key Vault resource solely to store one secret.
- *User-assigned Managed Identity (instead of system-assigned).* Useful if the same identity needs to be reused across multiple apps; not applicable here. System-assigned is simpler.

**Rationale.**
- Zero secrets to rotate. Token acquisition and refresh are handled automatically by `@azure/identity`.
- Smaller infrastructure footprint: no Key Vault resource, no Key Vault SDK dependency, no Key Vault role assignments.
- Microsoft's recommended pattern for service-to-service auth within Azure.
- Tenant ID and Bookings business ID are public identifiers and live as plain App Settings (they were never secrets despite being treated as such in the prior plan).

**Consequences.**
- Granting Microsoft Graph application permissions to a Managed Identity requires PowerShell or a Microsoft Graph API call (no portal UI for this step). The procedure is captured in `Infra/scripts/grant-graph-permissions.ps1` and run once per environment.
- The existing Azure AD app registration becomes unused for the booking flow and may be retained for fallback/diagnostic use or retired.
- `@azure/keyvault-secrets` is not required. `@azure/identity` is the only Azure SDK dependency for auth.

**Supersedes:** ADR-0006.

---

## ADR-0010: Node 22 LTS runtime

**Date:** 2026-05-05
**Status:** Accepted (supersedes ADR-0003)

**Context.** ADR-0003 selected Node 20. Azure Functions added Node 22 LTS support in 2025 with a long support window (active LTS until October 2025, maintenance LTS until April 2027).

**Decision.** Node 22 LTS for the Functions runtime; widget code is browser-targeted and unaffected by the runtime choice.

**Alternatives.**
- *Stay on Node 20.* Still supported by Functions; will hit end-of-life sooner and require an upgrade in 2026–2027.
- *Use Node 18.* End-of-life April 2025; would require an immediate upgrade.

**Rationale.** Picking the longest-supported LTS at the project's outset minimizes future runtime-upgrade cycles. Node 22 has the same operational characteristics as Node 20 for this workload — `fetch`, `crypto.subtle`, `AbortController` are all available; cold start performance is comparable.

**Consequences.** `engines.node` in `package.json` is set to `>=22.0.0`. The Functions App is provisioned with the Node 22 runtime. Local development requires Node 22 installed.

**Supersedes:** ADR-0003.

---

## ADR-0011: Drop the HMAC CSRF token; rely on defense-in-depth instead

**Date:** 2026-05-05
**Status:** Accepted (supersedes ADR-0007)

**Context.** ADR-0007 proposed an HMAC-signed CSRF token to replace the WordPress plugin's `wp_nonce`. Reviewing the threat model in the context of the no-secrets architecture decision (ADR-0009) revealed that the CSRF token does not meaningfully defend against any real threat for this endpoint.

**Decision.** No CSRF token. Bot and spam protection consists of four layers: CORS allowlist, hidden honeypot field, time-to-submit guard (3-second floor), and per-IP rate limiting (5 bookings/min, 30 slot lookups/min) backed by Azure Tables.

**Alternatives.**
- *Keep the HMAC token with a Key-Vault-stored secret.* Reintroduces Key Vault and the rotation problem the owner explicitly wants to avoid.
- *Keep the HMAC token with an ephemeral per-instance secret.* Tokens become invalid across cold starts and across scaled-out instances; degrades booking UX without proportionate security gain.
- *Cookie-based session token.* Breaks under third-party cookie restrictions in iframe contexts.

**Rationale.** Traditional CSRF protects authenticated state changes from being triggered by attacker-controlled forms. The booking endpoint has no authenticated users, no session state to abuse, and no privilege to escalate (anyone can submit anyway). The WordPress nonce was effectively a "form-was-loaded-from-our-site" check, which CORS already enforces in this architecture. Comparable embedded booking widgets (Calendly, Cal.com, HubSpot Meetings) use the same defense-in-depth model without a CSRF token.

**Consequences.**
- No `BOOKING_CSRF_SECRET` App Setting.
- The widget does not need to fetch a token at startup; the form-load → submit flow is one HTTP round trip simpler.
- Eliminates the last cryptographic secret in the system, completing the no-secrets-anywhere architecture.

**Supersedes:** ADR-0007.

---

## ADR-0012: Multi-tenant from Phase 1 (Flavor 1: multiple Bookings businesses, single M365 tenant)

**Date:** 2026-05-05
**Status:** Accepted (supersedes ADR-0005)

**Context.** ADR-0005 proposed single-tenant for Phase 1 with multi-tenant deferred. Owner indicated intent to deploy on multiple Onshore-owned properties (Onshore Unified Support, Onshore IT Services, Lighthouse, partner microsites) and prefers to build the multi-tenant capability in from the start rather than retrofit it.

**Decision.** Multi-tenant from day one, **Flavor 1** only: multiple Microsoft Bookings businesses within a single Microsoft 365 tenant (`onshoreoutsourcing.com`). Cross-Microsoft-tenant SaaS (Flavor 2) remains out of scope.

Configuration lives in a single `BOOKING_TENANTS` App Setting (JSON array). Each entry has:

- `slug`: short URL-safe identifier used in the embed snippet (`data-tenant="..."`)
- `businessId`: Microsoft Bookings business mailbox (private to the configuration; never exposed to embed snippets)
- `label`: human-readable name for diagnostics
- `allowedOrigins`: array of origins permitted to embed this tenant

Runtime flow: widget reads `data-tenant` from the mount element → sends slug to API → backend resolves slug to `businessId`, validates request `Origin` against `allowedOrigins`, uses `businessId` for Graph calls. Cache keys include the slug.

**Alternatives.**
- *Single-tenant Phase 1, multi-tenant later (the original ADR-0005 plan).* Saves ~4–6 hours up front; costs significantly more later because cache keys, API contracts, and storage schemas all change shape, and every existing embed snippet across host sites needs updating.
- *Cross-tenant SaaS (Flavor 2).* Deferred — different problem space; requires per-tenant auth strategy.

**Rationale.** The owner's stated intent of multiple properties means multi-tenant is needed eventually, not speculatively. Building it in now keeps cache keys, API contracts, security boundaries, and config schemas correct from launch. Adding a second property becomes a config edit, not a code change. Origin-to-business validation is in place from day one rather than retrofitted.

**Consequences.**
- Phase 1 effort grows by ~4–6 hours (config schema, slug resolver, origin validator, per-tenant cache keys, additional tests).
- Embed snippet has one extra attribute (`data-tenant="..."`).
- Slugs become a public-facing identifier that must be stable; renaming a slug invalidates existing embeds. Guidance: pick durable, descriptive slugs at first configuration.
- Adding a new property is a documented runbook procedure, not a development task.

**Supersedes:** ADR-0005.

---

## ADR-0013: Standalone GitHub repository

**Date:** 2026-05-05
**Status:** Accepted

**Context.** The booking widget could live inside an existing Onshore repository as a folder, or as its own standalone repository.

**Decision.** Standalone GitHub repository. The current `Bookings/` folder structure is shaped to be a clean repository root; when ready to migrate, the folder contents become the root of a new repo.

**Alternatives.**
- *Folder inside an existing repo.* Simpler initial setup; couples the booking widget's release cycle to the parent repo; complicates CI/CD targeting.

**Rationale.** Standalone repo enables clean GitHub Actions CI/CD targeting only the relevant code. Allows independent versioning, tagging, and release cadence. Supports later open-sourcing if that's ever desirable. Matches the pattern used by similar embeddable-widget projects.

**Consequences.** A separate repository must be created in Onshore's GitHub organization. Service principal credentials for Azure deploy live as repo secrets (no Microsoft Graph credentials, since Managed Identity handles that at runtime). Branch protection and PR review policies are set up at repo creation.

---

## ADR-0014: Code is brand-neutral; configuration carries identity

**Date:** 2026-05-05
**Status:** Accepted

**Context.** Owner directive: no server names or company names embedded in the code. Settings that vary per environment must be environment variables.

**Decision.** TypeScript, JavaScript, and CSS source files contain no Onshore-specific names, URLs, or business identifiers. The widget mount element ID is `booking-widget` (not `onshore-booking`). Package metadata (`package.json` `name`, `description`) is brand-neutral. All deployment-specific values come from Azure App Settings.

Documentation files (`Planning/`, `README.md`, `Infra/README.md`) describe an Onshore-owned project and may reference Onshore by name where appropriate to the documentation context.

**Alternatives.**
- *Embed "Onshore" in code for clarity.* Forecloses reuse, complicates open-sourcing, mixes brand and engineering concerns.
- *Make documentation brand-neutral too.* Unnecessary; documentation about an Onshore project naturally refers to Onshore.

**Rationale.** Strict code/configuration separation enables the same code to be deployed for different brands or properties without modification. Reduces the cost of any future open-sourcing or productization.

**Consequences.**
- Audit performed at the time of this ADR found and resolved: `windows-tz.ts` comment, `package.json` metadata, `local.settings.json.example` example values, `embed-test.html` mount ID and title, README embed snippet.
- Future code changes should preserve this separation. New configuration values that vary per environment go to App Settings, not code constants.
- The actual deployment hostname `onshorebookings.azurewebsites.net` appears in documentation and example embed snippets because it is the real hostname; widget code does not have this URL hardcoded — the widget detects its own origin at runtime.

---

## Open decisions (not yet ADRs)

| Topic | Status |
|---|---|
| First non-WordPress deployment target (which Onshore property goes first) | Pending — not required to begin the build |
| Cutover timing for the existing WordPress plugin | Pending — not required to begin the build |

These will be promoted to ADRs once decided.
