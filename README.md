# Onshore Booking Widget

Portable Microsoft Bookings widget. Embed on any website (WordPress, Wix, Squarespace, plain HTML, React app) with two lines of HTML.

## What this is

A self-contained booking experience built to replace the WordPress-only `simple-bookings` plugin. The architecture is a single Azure Functions app that serves both the embeddable widget script and the backend API endpoints that talk to Microsoft Graph. Authentication to Microsoft Graph uses a system-assigned Managed Identity — there are no rotating secrets and no Key Vault. Embed it on any site by pasting:

```html
<div id="booking-widget" data-tenant="unified-support"></div>
<script src="https://onshorebookings.azurewebsites.net/bookingwidget.js"></script>
```

The `data-tenant` attribute selects which configured Microsoft Bookings business to display (multi-tenant configuration is described in `Planning/architecture.md`).

## Folder layout

| Folder | Contents |
|---|---|
| `Planning/` | Architecture documents, decisions log, runbooks, integration guides |
| `App/` | Azure Functions app (TypeScript) — serves the widget files and the API endpoints, talks to Microsoft Graph |
| `Infra/` | Bicep templates that provision the Azure resources (Functions App, Key Vault, Storage, App Insights) |
| `Examples/` | Standalone HTML test pages and the canonical embed snippets for site owners |

## Status

In active development. The legacy Microsoft Bookings integration continues to run via the WordPress plugin at `../Wordpress/simple-bookings/` until the Functions-based stack is validated and the cutover plan is executed.

## Getting started

| Document | Purpose |
|---|---|
| `Planning/architecture.md` | Full design and architecture rationale |
| `Planning/decisions.md` | Architecture decisions log (ADRs) |
| `Planning/cicd-setup.md` | End-to-end runbook for setting up the GitHub repo, Azure federated credentials, and automated deployment |
| `Infra/README.md` | Infrastructure provisioning (manual via Portal, or Bicep) |

## Deployment

The repository ships with a GitHub Actions workflow (`.github/workflows/deploy.yml`) that builds, type-checks, tests, and deploys on every push to `main`. To set up the integration with Azure, follow `Planning/cicd-setup.md`.

For manual deployment (without GitHub Actions), see `Infra/README.md` Step 6.
