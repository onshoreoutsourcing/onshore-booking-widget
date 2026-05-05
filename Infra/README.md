# Infrastructure

The booking widget runs as a single Azure Functions App. The architecture has **no Key Vault** and **no rotating secrets**. Microsoft Graph authentication is handled by the Functions App's system-assigned Managed Identity, which is granted Microsoft Graph application permissions once at provisioning time.

There are two supported provisioning paths. Pick whichever fits your operational style:

- **[Manual deployment](#manual-deployment-via-the-azure-portal)** — point-and-click via the Azure Portal. Faster for a first deployment; harder to reproduce; better when you're learning the moving parts.
- **[Bicep templates](#bicep-deployment-via-infrastructure-as-code)** — declarative infrastructure-as-code. Slower to author once; the rebuild-the-whole-stack command is a one-liner; required for CI/CD-driven environment provisioning.

Both paths produce the same result. You can start with one and migrate to the other later — Bicep templates can adopt existing resources via `existing` references.

## Resources provisioned

Either path produces these resources:

| Resource | Purpose |
|---|---|
| Resource Group | Container for all booking-related resources (e.g. `rg-onshorebookings`) |
| Storage Account | Required by Functions runtime; also hosts the Tables used for rate-limiting |
| App Service Plan (Consumption, Linux) | Compute reference for the Functions App |
| Functions App (Linux, Node 22 LTS) | Named `onshorebookings`; default URL `https://onshorebookings.azurewebsites.net` |
| System-assigned Managed Identity | On the Functions App; granted Microsoft Graph application permissions |
| Application Insights | Telemetry, logs, distributed tracing |
| Log Analytics Workspace | Backing store for App Insights |
| Custom Domain Binding *(future)* | Deferred to Phase 2 — see ADR-0008 |

**Not provisioned:** Azure Key Vault, Azure AD app registration with client secret. The architecture deliberately has no secrets to store.

---

## Manual deployment via the Azure Portal

For a first deployment, or when iterating on the architecture before committing to IaC. After this initial setup, code deploys via VS Code's Azure Functions extension, the `func` CLI, or a GitHub Actions workflow.

### Step 1: Verify the Functions App configuration

If you've already created the Functions App, open it in the Azure Portal and confirm these settings:

1. **Configuration → General settings**
   - Stack: **Node**
   - Major version: **22 LTS**
   - Platform: **64 Bit**
   - HTTPS Only: **On**
   - Minimum TLS version: **1.2** or higher

2. **Configuration → Function runtime settings**
   - Runtime version: **~4**

3. **Configuration → Application settings** — these will be populated in Step 3.

If any of the above is wrong, fix it before proceeding. Changing the Node version or runtime later requires a restart and may invalidate cached state (which is fine, just be aware).

### Step 2: Enable system-assigned Managed Identity

This is the credential the Functions App uses to call Microsoft Graph. Without it, no booking flow works.

1. In the Functions App, open **Settings → Identity**
2. Select the **System assigned** tab
3. Set **Status** to **On**
4. Click **Save**
5. After save, copy the **Object (principal) ID** — you'll need it in Step 4

If you see "An object with this ID already exists" or similar, the identity is already enabled and you can just copy the Object ID.

### Step 3: Configure Application Settings

In the Functions App, open **Configuration → Application settings** and add the following. Click **+ New application setting** for each one. Click **Save** when done — the Functions App restarts.

| Name | Value |
|---|---|
| `FUNCTIONS_WORKER_RUNTIME` | `node` |
| `FUNCTIONS_EXTENSION_VERSION` | `~4` |
| `WEBSITE_NODE_DEFAULT_VERSION` | `~22` |
| `BOOKING_TENANTS` | (see below) |

**`BOOKING_TENANTS`** is the multi-tenant configuration: a JSON array (single-line string) describing each Microsoft Bookings business this app serves. See `Planning/architecture.md` for the schema. Example:

```json
[{"slug":"unified-support","businessId":"OnshoreUnifiedSupport@onshoreoutsourcing.com","serviceId":"2119a826-85ee-43d9-9621-d0e8e3c0f9f2","label":"Onshore Unified Support","allowedOrigins":["https://onshoreunifiedsupport.com"]}]
```

The Azure Portal accepts the JSON as a single-line string. Validate with `jq` or a JSON linter before pasting if you've assembled it by hand.

`AzureWebJobsStorage` should already be set automatically when the Functions App was created with a storage account — verify it exists; do not overwrite it.

`APPLICATIONINSIGHTS_CONNECTION_STRING` should already be set if Application Insights is wired up — verify; do not overwrite.

### Step 4: Configure CORS

In the Functions App, open **API → CORS**.

You have two options:

- **Option A (simpler):** Add `*` to the Allowed Origins. Per-tenant origin validation happens inside the function code regardless, so the platform-level CORS check becomes a permissive first pass.
- **Option B (defense-in-depth):** List every origin that's allowed to embed the widget across all tenants — e.g. `https://onshoreunifiedsupport.com`, `https://onshoreitservices.com`, etc. Each new tenant's origins must be added here too.

**Do not check** "Enable Access-Control-Allow-Credentials" — the booking widget does not use cookies, and enabling this prevents wildcard origin support.

Click **Save**.

### Step 5: Grant Microsoft Graph permissions to the Managed Identity

The Managed Identity needs the `BookingsAppointment.ReadWrite.All` Microsoft Graph application permission. This **cannot be granted through the Azure Portal UI for managed identities** — it requires PowerShell or a Microsoft Graph API call.

The PowerShell script `Infra/scripts/grant-graph-permissions.ps1` (to be authored) automates this. Manual procedure for now:

```powershell
# Connect to Microsoft Graph as a tenant admin
Connect-MgGraph -Scopes "AppRoleAssignment.ReadWrite.All","Application.Read.All"

# Variables — fill in your values
$ManagedIdentityObjectId = "<paste the Object ID copied in Step 2>"
$RequiredPermissions     = @("BookingsAppointment.ReadWrite.All")

# Resolve the Microsoft Graph service principal in your tenant
$GraphSp = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"

# Grant each required permission
foreach ($Perm in $RequiredPermissions) {
    $AppRole = $GraphSp.AppRoles | Where-Object { $_.Value -eq $Perm }
    if (-not $AppRole) { throw "Permission $Perm not found on the Microsoft Graph service principal." }

    New-MgServicePrincipalAppRoleAssignment `
        -ServicePrincipalId $ManagedIdentityObjectId `
        -PrincipalId $ManagedIdentityObjectId `
        -ResourceId $GraphSp.Id `
        -AppRoleId $AppRole.Id

    Write-Host "Granted $Perm"
}
```

This requires a tenant administrator account. Once granted, the assignment persists; you do not need to re-run this script unless permissions change.

To verify: the grant shows up under **Microsoft Entra ID → Enterprise applications → All applications**, search for the Functions App's name (which is the Managed Identity's display name). Click into it, then **Permissions**, and you should see `BookingsAppointment.ReadWrite.All`.

### Step 6: Deploy the code

You have several options. Pick whichever fits your workflow:

**Option A: VS Code Azure Functions extension**
1. Open the `App/` folder in VS Code
2. Install the Azure Functions extension if not already
3. Run `npm install` and `npm run build` in the `App/` folder
4. In VS Code, sign in to Azure
5. Right-click the Functions App in the Azure tree view → **Deploy to Function App**

**Option B: `func` CLI (Azure Functions Core Tools)**
1. Install Core Tools: `npm install -g azure-functions-core-tools@4`
2. From the `App/` folder: `func azure functionapp publish onshorebookings`

**Option C: Zip deploy via the Portal**
1. From the `App/` folder, run `npm install` and `npm run build`
2. Zip the contents (not the folder itself) into `app.zip`
3. In the Azure Portal: **Functions App → Advanced Tools → Go** (this opens Kudu)
4. Drag `app.zip` to the deploy area, or use the API endpoint

**Option D: GitHub Actions** (recommended once stable)
- See `.github/workflows/deploy.yml` (to be authored). One-time setup of a service principal and a federated credential; subsequent deploys are automatic on push to `main`.

### Step 7: Verify the deployment

After deploy, in the Functions App:

1. Open **Functions** in the left nav. You should see `GetSlots`, `CreateBooking`, and `ServeWidget` listed.
2. Click `GetSlots` → **Code + Test** → **Get function URL** → copy the URL
3. Open the URL in a browser, appending `?tenant=<your-slug>`. You should see a JSON response with `slots`.
4. If you get a 404 with "tenant not found", verify `BOOKING_TENANTS` is set correctly.
5. If you get a 502 with "Failed to acquire Microsoft Graph access token", verify Step 5 was completed.
6. Check **Monitor → Logs** for any startup errors.

For end-to-end widget testing, point `Examples/embed-test.html` at your Functions App URL and open it in a browser.

---

## Bicep deployment via Infrastructure-as-Code

To be authored. The Bicep templates will live alongside this README and codify the same setup the manual path describes.

### Files (planned)

| File | Purpose |
|---|---|
| `main.bicep` | Top-level template; orchestrates the modules |
| `modules/storage.bicep` | Storage Account and Tables |
| `modules/functions.bicep` | App Service Plan, Functions App with system-assigned Managed Identity, App Insights, Log Analytics |
| `modules/domain.bicep` *(Phase 2)* | Custom domain binding and TLS certificate |
| `parameters/prod.parameters.json` | Production values (resource names, region, tags) |
| `parameters/staging.parameters.json` | Staging values |
| `scripts/grant-graph-permissions.ps1` | Post-provisioning script that grants Graph application permissions to the Managed Identity |

### Deployment

```sh
# Login to Azure
az login

# Select the target subscription
az account set --subscription <SUBSCRIPTION_ID>

# Deploy to a resource group (will create it if missing)
az deployment group create \
  --resource-group rg-onshorebookings \
  --template-file main.bicep \
  --parameters parameters/prod.parameters.json
```

After Bicep deployment completes, run `scripts/grant-graph-permissions.ps1` (PowerShell, tenant admin required).

### Adopting an existing manually-provisioned Functions App

If you've followed the manual path and now want to manage the resources via Bicep:

1. Author the Bicep template normally
2. Add `existing` references where you want to keep the manually-created resources
3. Run `az deployment group what-if` to verify Bicep won't recreate or modify them unexpectedly
4. Then `az deployment group create` to bring them under IaC management

This works because Bicep is declarative — if the desired state matches the actual state, no changes are made.

---

## App Settings reference

The Bicep templates configure the same App Settings the manual path documents:

| Setting | Source | Notes |
|---|---|---|
| `BOOKING_TENANTS` | Bicep parameter / pipeline variable / Portal | JSON array of tenant configurations. Format documented in `Planning/architecture.md`. |
| `AzureWebJobsStorage` | Bicep — references the storage account connection string | Required by Functions runtime |
| `FUNCTIONS_WORKER_RUNTIME` | Bicep / Portal | Set to `node` |
| `FUNCTIONS_EXTENSION_VERSION` | Bicep / Portal | Set to `~4` |
| `WEBSITE_NODE_DEFAULT_VERSION` | Bicep / Portal | Set to `~22` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Bicep | Auto-bound to the App Insights resource |

Local development uses `App/local.settings.json` (gitignored). See `App/local.settings.json.example` for the structure.

## Status

Manual deployment path documented and validated. Bicep templates not yet written; tracked as a Phase 2 deliverable so the same provisioning is reproducible and CI-driven.
