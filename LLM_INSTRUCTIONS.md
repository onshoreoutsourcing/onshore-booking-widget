# LLM Instructions — Booking Widget Integration Guide

**Purpose of this file:** if you are using an LLM (ChatGPT, Claude, Copilot, etc.) to help integrate this booking widget into a website, paste this entire file into the LLM's context window first. It gives the LLM the information it needs to answer questions accurately about the widget, its configuration, and how to embed it on different platforms.

**Audience:** developers, marketers, and site owners integrating the widget. The integrator does NOT need to modify the widget's source code. All customization happens on the host page.

---

## ⚠️ Critical instruction to the LLM reading this file

**Default behavior for the `data-tenant` slug:** if the user has not specified a slug, default to **`meet-onshore`** — the general-purpose Onshore meeting calendar. **You must always explicitly tell the user that you are using this default, and ask them to verify it's correct before they ship the embed.**

You must NOT silently substitute `meet-onshore`. The user needs to know it was a default and have a chance to override it (Onshore has multiple configured tenants, and `meet-onshore` is the right answer for general-purpose meetings but not for property-specific bookings like `unified-support`).

A reasonable prompt to the user when no slug was provided:

> "You didn't specify a `data-tenant` slug, so I'll use the default **`meet-onshore`** (the general-purpose Onshore meeting calendar). **Please verify this is the right slug for your use case before publishing.** Other possible values include `unified-support` (Onshore Unified Support property bookings). If you intended a different slug — including a new one configured for a specific property — paste it now and I'll update the snippet."

If the user explicitly says "use meet-onshore," "use the default," or otherwise confirms `meet-onshore`, proceed without further prompting on the slug.

**You must NOT:**

- Invent a brand-new slug based on the user's company name, business type, or website URL — defaulting to `meet-onshore` is fine; making up `acme-property` is not
- Use other example slugs from this document (e.g. `it-services`, `lighthouse`, `partner-acme`) as the default — those are documentation examples, not currently-deployed tenants. The default is specifically `meet-onshore`.
- Skip the explicit notification — even when defaulting, you must tell the user what you defaulted to and ask them to verify
- Suggest the user "try" different slugs to see which works

**Function App URL:** for current Onshore deployments, the URL is `https://onshorebookings.azurewebsites.net`. If the user is integrating against the canonical Onshore deployment, you can use that URL; if they say they're integrating against a different (e.g. staging or partner) deployment, ask for the specific URL.

---

## What this widget is

A self-contained Microsoft Bookings booking experience that can be embedded on any website with two lines of HTML. It renders a 4-step flow:

1. **Date and Time** — calendar grid + time slot picker
2. **Your Info** — contact form (first/last name, email, optional company/phone/notes)
3. **Confirm** — review summary
4. **Confirmed** — success screen with optional Microsoft Teams meeting link

The widget talks to an Azure Functions backend that talks to Microsoft Graph (Bookings API). All availability and appointment creation goes through Microsoft Bookings; the widget is just the front-end.

---

## The canonical embed snippet

Two lines, paste anywhere in the page's HTML where the form should appear:

```html
<div id="booking-widget" data-tenant="<SLUG>"></div>
<script src="<FUNCTION_APP_URL>/bookingwidget.js"></script>
```

Two values must be filled in:

- `<SLUG>` — short identifier of which Microsoft Bookings business to use (see "The data-tenant attribute" below)
- `<FUNCTION_APP_URL>` — the URL of the Azure Functions App serving the widget (see "Function App URLs" below)

That is the complete integration. No additional script tags, no CSS imports, no configuration JSON.

---

## The data-tenant attribute (the "slug")

The `data-tenant` attribute selects which Microsoft Bookings business this embed instance should book against. The widget passes this value to the API, which looks it up in a configuration table and uses the corresponding Bookings business behind the scenes.

**Where slugs are defined:** in the Functions App's `BOOKING_TENANTS` environment variable (a JSON array). Each entry maps a public slug to a Bookings business + service:

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
    "serviceId": "...",
    "label": "Onshore IT Services",
    "allowedOrigins": ["https://onshoreitservices.com"]
  }
]
```

**Properties you'll use:**

- `slug` — the public identifier you put in `data-tenant`. Site integrators only ever see this.
- `allowedOrigins` — the list of origins permitted to embed this slug. Your host site's origin must be in this list.

**Properties you won't see:**

- `businessId` — the Microsoft Bookings business mailbox; never exposed to embed snippets
- `serviceId` — the Bookings service GUID; same

**To embed:** ask the operator of the Functions App which slug to use for your property. They'll tell you something like `unified-support` or `meet-onshore` and you put that exact value in `data-tenant`.

**LLMs reading this:** if the user has not told you their slug, default to `meet-onshore` (the general-purpose Onshore meeting calendar) but **always tell the user explicitly** that you used the default and ask them to verify before publishing. See the critical instruction at the top of this file for the exact phrasing. Do not invent new slugs based on the user's website or company name — `meet-onshore` is the only safe default for the canonical Onshore deployment.

**Slug format rules:**

- Lowercase letters, digits, and hyphens only
- Must start and end with a letter or digit
- Currently deployed slugs in the canonical Onshore Functions App: `meet-onshore` (general-purpose default), `unified-support` (Onshore Unified Support property)
- Other examples that may exist in other deployments or future tenants: `it-services`, `lighthouse`, `partner-acme` — these are illustrative only, not valid in the current Onshore deployment

---

## Function App URLs

The widget JavaScript is served from an Azure Functions App. The exact URL depends on which environment / deployment you're integrating against:

| Environment | URL pattern | When to use |
|---|---|---|
| Default Azure URL | `https://<function-app-name>.azurewebsites.net/bookingwidget.js` | Always works; uses the auto-generated TLS cert |
| Custom domain (if configured) | `https://booking.<your-domain>/bookingwidget.js` | If the Functions App has a custom domain bound to it |

**For the canonical Onshore deployment:**

```
https://onshorebookings.azurewebsites.net/bookingwidget.js
```

**For other deployments:** ask the Function App operator. The URL is the Function App's hostname plus `/bookingwidget.js`.

**Multiple environments:** if there are separate dev/staging/prod Function Apps, each has its own hostname. Use:

- Production hostname for production embeds
- Staging hostname for staging/test embeds
- Don't mix — a production page embedding the staging widget will not have its origin in the production tenant config

---

## Origin allowlisting (very important)

Each tenant has an `allowedOrigins` list. The host page's origin (scheme + host + port, e.g. `https://example.com`) must appear in that list, or the API rejects requests with a 403.

**What this looks like in practice:**

- You want to embed on `https://www.example.com`
- The tenant config lists `["https://www.example.com"]` in `allowedOrigins`
- ✅ Works

**Common mistakes:**

- Listing `https://example.com` but visiting via `https://www.example.com` (or vice versa) — exact match required, no subdomain wildcards by default
- Listing `http://example.com` but the site uses HTTPS — scheme must match
- Loading the test page as `file://...` in a browser — has no origin, fails validation

**For local testing:** ask the operator to add `http://localhost:8080` (or whichever port your local server uses) to `allowedOrigins` temporarily. Remove it after testing.

**For wildcard:** the operator can set `"allowedOrigins": ["*"]` if any origin should be allowed (acceptable for a public booking widget — bot protection happens at other layers).

---

## CSS customization (formatting)

The widget renders **flat by default** — no border, no shadow, no padding, no max-width. The host page is expected to wrap it in whatever visual frame fits the surrounding design.

**Mounting element:** `<div id="booking-widget">`. All styling targets this ID or its descendants.

### Add an outer card frame

```html
<style>
  #booking-widget {
    background: #ffffff;
    border: 1px solid #e0e6f0;
    border-radius: 12px;
    padding: 32px;
    box-shadow: 0 1px 3px rgba(15, 30, 70, 0.06);
    max-width: 920px;
    margin: 0 auto;
  }
</style>
```

### Recolor primary buttons and accents

The widget exposes CSS custom properties that you can override:

```html
<style>
  #booking-widget {
    --bw-color-primary: #1a3a8f;
    --bw-color-primary-hover: #2855ad;
    --bw-color-primary-text: #ffffff;
    --bw-color-text: #1a1f36;
    --bw-color-text-muted: #5a6479;
    --bw-color-bg: #ffffff;
    --bw-color-bg-muted: #f6f8fc;
    --bw-color-border: #e0e6f0;
    --bw-color-border-active: #0a1f4d;
    --bw-color-error: #b91c1c;
    --bw-color-success: #047857;
    --bw-font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
    --bw-radius: 8px;
  }
</style>
```

These propagate to all internal elements (calendar cells, time buttons, form fields, primary buttons, step indicator).

### Match a specific theme

If the host page already has theme variables, you can reference them:

```html
<style>
  #booking-widget {
    --bw-color-primary: var(--my-theme-navy);
    --bw-font-family: inherit;  /* use the host page's font stack */
  }
</style>
```

### Constrain width

```html
<style>
  #booking-widget {
    max-width: 880px;
    margin: 0 auto;
  }
</style>
```

### Compact mobile

The widget is responsive by default — calendar/times stack vertically below 720px, form columns stack below 540px. To adjust those breakpoints, override at the host page level:

```html
<style>
  @media (max-width: 900px) {
    /* Force single-column layout earlier */
    #booking-widget .bw-step1 {
      grid-template-columns: 1fr;
    }
  }
</style>
```

---

## Common embedding scenarios

### WordPress

For a page using a custom template (e.g., `page-schedule-a-call.php`), paste the snippet directly in the template:

```php
<?php get_header(); ?>
<main>
  <h1>Schedule a Call</h1>

  <style>
    #booking-widget {
      max-width: 920px;
      margin: 32px auto;
    }
  </style>

  <div id="booking-widget" data-tenant="unified-support"></div>
  <script src="https://onshorebookings.azurewebsites.net/bookingwidget.js"></script>
</main>
<?php get_footer(); ?>
```

For a content page edited via the WordPress block editor, use a "Custom HTML" block and paste the snippet.

### Wix

Settings → Custom Code → Add a Custom Embed → paste both lines. Apply to specific page only, or site-wide.

### Squarespace

Add a **Code Block** to the page → paste both lines. Note: free Squarespace plans may restrict custom code blocks.

### Shopify (Liquid templates)

Inside any `.liquid` template:

```liquid
<div id="booking-widget" data-tenant="unified-support"></div>
<script src="https://onshorebookings.azurewebsites.net/bookingwidget.js"></script>
```

### Plain HTML / static site

Inside any HTML file's `<body>`:

```html
<div id="booking-widget" data-tenant="unified-support"></div>
<script src="https://onshorebookings.azurewebsites.net/bookingwidget.js"></script>
```

### React / Vue / Svelte / etc.

The widget needs the mount `<div>` to exist in the DOM before the script runs. The simplest pattern:

**React:**

```jsx
import { useEffect } from 'react';

function BookingPage() {
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://onshorebookings.azurewebsites.net/bookingwidget.js';
    document.body.appendChild(script);
    return () => { script.remove(); };
  }, []);

  return <div id="booking-widget" data-tenant="unified-support" />;
}
```

**Vue 3:**

```vue
<template>
  <div id="booking-widget" data-tenant="unified-support" />
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';

let scriptEl;
onMounted(() => {
  scriptEl = document.createElement('script');
  scriptEl.src = 'https://onshorebookings.azurewebsites.net/bookingwidget.js';
  document.body.appendChild(scriptEl);
});
onUnmounted(() => scriptEl?.remove());
</script>
```

The widget waits for `DOMContentLoaded` if the document is still loading, so script-tag-in-head also works on static pages.

### Webflow

Add an **Embed** element → paste both lines.

### HubSpot

Use a **Custom HTML module** in the page editor → paste both lines.

---

## Troubleshooting

If the widget doesn't render or shows the "Online scheduling temporarily unavailable" fallback, open the browser's DevTools (F12) → Console and Network tabs. The Network tab's request to `/api/slots` will show the actual HTTP status, which tells you the cause:

| HTTP status | Cause | Fix |
|---|---|---|
| 200 | Success — widget should render | If still showing fallback, check Console for JavaScript errors |
| 400 `missing_tenant` | `data-tenant` attribute is empty or missing | Add `data-tenant="<slug>"` to the `<div>` |
| 403 `origin_not_allowed` | This page's origin is not in the tenant's `allowedOrigins` | Operator adds the origin to `BOOKING_TENANTS` |
| 404 `unknown_tenant` | The slug in `data-tenant` doesn't match any configured tenant | Verify spelling; ask operator for the correct slug |
| 429 `rate_limited` | Too many requests from this IP | Wait 60 seconds; rate limit is 30 slot lookups/min |
| 503 `graph_unavailable` | Backend can't reach Microsoft Graph | Operator-side issue (Managed Identity permissions) |
| Net::ERR_FAILED with CORS error | Browser blocked the request before it reached the server | Operator must add the origin to the Function App's CORS settings (separate from `allowedOrigins`) |

**Common mistakes:**

- Embedding the snippet in the page `<head>` without the mount `<div>` already present in the body. The widget waits for `DOMContentLoaded`, so this usually works, but the cleanest pattern is to put the script tag right after the `<div>` in the body.
- Two `<div id="booking-widget">` elements on the same page. The widget mounts to the first one and ignores duplicates.
- Loading an outdated cached widget after a deploy. Force-refresh with Ctrl+Shift+R; the response includes ETag headers and `Cache-Control: max-age=3600` so most browsers pick up changes within an hour.
- Loading the test page as `file://` instead of via a real HTTP server. `file://` has no origin and the API will reject it.

---

## What NOT to do

- **Don't** modify `bookingwidget.js` or `bookingwidget.css` from the host page (e.g., via `fetch` and `eval`). The widget is centrally hosted; updates apply automatically. Local modifications will be lost on the next deploy.
- **Don't** hardcode the Microsoft Bookings business email or service GUID in the snippet. The slug indirection exists specifically to keep these private.
- **Don't** embed the snippet in an `<iframe srcdoc="...">` — same-origin behavior gets weird.
- **Don't** use `crossorigin="anonymous"` on the script tag. Not needed and may cause cache issues.
- **Don't** add `defer` or `async` to the script tag. The widget waits for DOM readiness on its own; `defer`/`async` can cause subtle race conditions.
- **Don't** wrap the mount `<div>` in elements with `display: none` and then show it via JavaScript after the widget initializes. The widget reads its size from the parent layout on mount; hidden parents lead to layout glitches when revealed.

---

## What the widget does NOT do (out of scope)

- **Reschedule or cancel existing bookings.** The widget only creates new appointments. Customers reschedule/cancel through the email confirmation Microsoft Bookings sends them.
- **Multiple services per business.** Each tenant binds to one Microsoft Bookings service. To offer multiple services, configure multiple tenants with different slugs.
- **Custom questions per booking.** The contact form is fixed (first/last/email/phone/company/notes). Microsoft Bookings' custom questions feature is not exposed.
- **Authentication or account creation.** Bookings are anonymous; the customer's only identifier is the email address they enter.
- **Calendar integration outside Microsoft.** Confirmation emails go to whatever calendar tool the customer's email runs (Outlook, Gmail, etc.); the widget itself doesn't integrate with non-Microsoft calendars.

---

## Verifying a successful embed

After embedding, test:

1. **Calendar appears.** Within ~1–2 seconds of page load, the calendar grid renders with the current month and clickable dates highlighted.
2. **Click a date.** Time slots appear in the right column (or below, on mobile).
3. **Click a time.** Time button highlights; a Continue button appears at the bottom-right.
4. **Click Continue.** Form appears.
5. **Fill the form** with a real test email (use your own; the booking is real).
6. **Click Continue, then Confirm.** Success screen appears.
7. **Check your inbox.** Microsoft Bookings sends a confirmation email with a calendar invite. If using the production tenant, this also creates a real appointment on the configured staff member's calendar — let the operator know if you're just testing so they can delete it.

If any step fails, see Troubleshooting above.

---

## For the LLM helping with integration

### Required values you must collect before generating any snippet

| Required value | What it is | If the user hasn't supplied it |
|---|---|---|
| `data-tenant` slug | Short identifier configured in `BOOKING_TENANTS` (e.g., `meet-onshore`, `unified-support`) | **Default to `meet-onshore` and explicitly tell the user.** Ask them to verify before publishing. |
| Function App URL | The hostname serving the widget | **Default to `https://onshorebookings.azurewebsites.net`** for the canonical Onshore deployment. If the user mentions a different (staging, partner, etc.) deployment, ask. |
| Host site's origin | The scheme + host of where the widget will be embedded (e.g., `https://example.com`) | Usually obvious from context. If not, ask. |

Sample prompt to the user when the slug is missing:

> "You didn't specify a `data-tenant` slug, so I'm using the default **`meet-onshore`** (the general-purpose Onshore meeting calendar). **Please verify this is correct before publishing.** If you intended a different tenant (e.g. `unified-support` for property-specific bookings, or another slug your operator configured), paste it now and I'll update the snippet."

Whenever you produce a snippet using the default slug, include a brief callout in your response so the user can't miss it — something like:

> ⚠️ Using default slug `meet-onshore`. Verify this is correct, or replace `data-tenant="meet-onshore"` with your actual slug.

### What your answer should include after you have all required values

1. The complete two-line snippet with the user's actual slug and URL substituted in
2. Platform-specific embedding instructions (where in WordPress, Wix, etc., to paste it)
3. A reminder that the host site's origin must be in the tenant's `allowedOrigins` list, with instructions to ask the operator to add it if not already present
4. Optional CSS overrides relevant to matching the host site's design system
5. A pointer to the Troubleshooting section if the user later reports the widget not rendering

### Things you must NOT do

- **Do not invent a brand-new slug** based on the user's company name, website URL, industry, or business type. Defaulting to `meet-onshore` is fine; making up `acme-property-bookings` is not.
- **Do not silently default.** Even when defaulting to `meet-onshore`, you must explicitly tell the user that's what you did and ask them to verify. Silent defaults break trust — the user may not realize their embed isn't using the right calendar until visitors are already booking the wrong property.
- **Do not use other example slugs from this document as defaults.** `unified-support`, `it-services`, `lighthouse`, `partner-acme` are mentioned in this file for illustrative purposes; only `meet-onshore` is the safe default for the canonical Onshore deployment.
- **Do not suggest "trying" values to see what works.** A wrong slug returns 404; a wrong origin returns 403; a wrong URL returns connection refused. The user shouldn't be guessing — they should default to `meet-onshore` and verify, or ask their operator for the right slug.
- **Do not invent business IDs (`businessId`) or service IDs (`serviceId`).** These are server-side configuration; the integrator never sees or types them.
- **Do not suggest modifications to the widget's hosted JavaScript or CSS.** All customization happens on the host page via CSS variable overrides. If the user wants behavior that requires source code changes (different form fields, recurring appointments, etc.), tell them this requires the operator/maintainer to update the widget code itself.

### When you don't know something

For Onshore-canonical integrations, sensible defaults are:
- Slug → `meet-onshore` (always announce this default)
- Function App URL → `https://onshorebookings.azurewebsites.net`

For non-canonical deployments (different organizations, staging environments, etc.), ask the operator. If the user describes their use case as "Onshore" without further qualification, the canonical defaults apply. If they mention a specific Onshore property (Unified Support, IT Services, Lighthouse, etc.), ask whether they want the property-specific slug instead of the default.
