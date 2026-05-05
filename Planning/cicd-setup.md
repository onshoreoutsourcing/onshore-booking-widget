# CI/CD Setup — GitHub Actions to Azure Functions

End-to-end runbook for connecting a fresh GitHub repository to the manually-provisioned Azure Functions App for automated build, test, and deploy.

After this is set up, every push to `main` automatically:

1. Type-checks the backend and the widget
2. Runs the unit-test suite
3. Builds the widget bundle and compiles TypeScript
4. Deploys the result to the Functions App

Authentication uses **OpenID Connect federated credentials** — no client secret is stored in GitHub.

## Prerequisites

Before you start, you will need:

- **Azure CLI** installed locally (`az --version` to verify; install from https://aka.ms/installazurecli)
- **Azure tenant administrator access** — required to create the federated credential and assign roles
- **Git** installed locally
- **Write access** to the Onshore GitHub organization (or a personal account if not creating it under the org)
- **The Functions App already provisioned** in Azure (the manual setup in `Infra/README.md` Steps 1–5 should be complete; code may or may not be deployed yet)

## Overview of what we'll do

| Phase | What happens | Time |
|---|---|---|
| 1. Create the GitHub repository | A new empty repo gets created at github.com | ~3 min |
| 2. Get the code into the repo | The contents of the `Bookings/` folder become the repo's initial commit | ~10 min |
| 3. Set up Azure federated credentials | An Azure AD app + service principal + federated credential trust GitHub's OIDC tokens | ~10 min |
| 4. Configure GitHub repo secrets | The three identifiers GitHub needs to authenticate to Azure | ~3 min |
| 5. Trigger the first deployment | Push the branch and watch the workflow run | ~5 min |
| **Total** | | **~30 min** |

---

## Phase 1: Create the GitHub repository

### 1.1 Create an empty repo

Two options:

**Option A — GitHub web UI (recommended for first setup):**

1. Go to https://github.com/new (or https://github.com/organizations/<org>/repositories/new for an organization)
2. **Owner**: pick the appropriate organization or your account
3. **Repository name**: suggested: `onshore-booking-widget`
4. **Description**: "Embeddable Microsoft Bookings widget powered by Azure Functions"
5. **Visibility**: Private (unless you have a reason to make it public)
6. **Do NOT initialize with a README, .gitignore, or license** — we already have these
7. Click **Create repository**

GitHub will show a "Quick setup" page with HTTPS and SSH URLs — keep this tab open, you'll need the URL in Phase 2.

**Option B — `gh` CLI:**

```sh
gh repo create onshore-booking-widget \
  --private \
  --description "Embeddable Microsoft Bookings widget powered by Azure Functions"
```

This both creates the repo and configures it as a remote on the current local directory if you run it from inside one. We're not in a local repo yet, so create it without that flag and we'll add the remote in Phase 2.

### 1.2 Note your repo's full path

You'll need the **full path** in `<org>/<repo>` form (e.g. `onshoreoutsourcing/onshore-booking-widget`) for later steps. Copy this for reference.

---

## Phase 2: Get the code into the repository

### 2.1 The OneDrive caveat

**Do not initialize git inside the OneDrive folder.** OneDrive's sync behavior can corrupt git's internal state (`.git/objects`, `.git/index`, etc.). The recommended workflow is:

1. Pick a non-OneDrive location for the local clone (e.g. `C:\repos\` or `~/repos/`).
2. Clone the new empty repo there.
3. Copy the `Bookings/` folder contents into the cloned repo.
4. Commit and push.

The OneDrive copy of `Bookings/` becomes a one-time source — going forward, the git repo is the source of truth.

### 2.2 Clone the empty repo

Open a terminal in your chosen non-OneDrive parent folder (e.g. `C:\repos\`):

```sh
git clone https://github.com/<org>/onshore-booking-widget.git
cd onshore-booking-widget
```

The folder will be empty except for `.git/`.

### 2.3 Copy files in

Copy the **contents** of the OneDrive `Bookings/` folder into your new repo folder (not the folder itself — the *contents*).

**On Windows (PowerShell):**

```powershell
$source = "C:\Users\ShaneCribbs\OneDrive - Onshore Outsourcing\Products and Solutions\Unified Support\02_Go_To_Market\Website\Bookings"
$dest   = "C:\repos\onshore-booking-widget"
Copy-Item -Path "$source\*" -Destination $dest -Recurse -Force
```

**On macOS/Linux:**

```sh
SOURCE="$HOME/OneDrive - Onshore Outsourcing/Products and Solutions/Unified Support/02_Go_To_Market/Website/Bookings"
DEST="$HOME/repos/onshore-booking-widget"
cp -R "$SOURCE"/. "$DEST"/
```

After copying, the repo folder should contain:

```
onshore-booking-widget/
├── .git/                  ← created by git clone
├── .github/
│   └── workflows/
│       └── deploy.yml
├── .gitignore
├── App/
├── Examples/
├── Infra/
├── Planning/
└── README.md
```

Note that `.github/` and `.gitignore` are dotfiles and may not be visible in some file managers. PowerShell's `Copy-Item -Force` and `cp -R` both handle them.

### 2.4 Generate `package-lock.json`

The CI workflow runs `npm ci` which requires `package-lock.json`. Generate it now by installing dependencies once locally:

```sh
cd App
npm install
cd ..
```

This creates `App/package-lock.json` and `App/node_modules/`. The lock file is committed; `node_modules/` is gitignored.

### 2.5 Initial commit and push

```sh
git add .
git status         # verify what's about to be committed
git commit -m "Initial commit: project scaffolding, lib code, widget, tests, CI"
git branch -M main
git push -u origin main
```

After this, the code is in GitHub. Visit `https://github.com/<org>/onshore-booking-widget` to confirm.

The `Actions` tab will show a workflow run was queued — but it will **fail** because the Azure secrets aren't configured yet. That's expected and resolves itself in Phase 5.

---

## Phase 3: Set up Azure federated credentials

This phase creates an Azure AD application that GitHub Actions will impersonate when deploying. The application has no client secret; instead, it trusts GitHub's OIDC tokens for the specific repo and branch we configure.

### 3.1 Sign in to Azure

```sh
az login
az account show         # verify you're in the right tenant
```

If multiple subscriptions are available, set the active one:

```sh
az account set --subscription "<SUBSCRIPTION_ID>"
```

### 3.2 Capture environment values

Set shell variables for the rest of the commands:

```sh
APP_DISPLAY_NAME="onshorebookings-github-deploy"
GITHUB_ORG="<your-org-or-username>"          # e.g. onshoreoutsourcing
GITHUB_REPO="onshore-booking-widget"
RESOURCE_GROUP="rg-onshorebookings"
FUNCTION_APP="onshorebookings"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)

echo "Subscription: $SUBSCRIPTION_ID"
echo "Tenant:       $TENANT_ID"
```

Verify these values match the Azure subscription where the Functions App lives.

### 3.3 Create the Azure AD application and service principal

```sh
APP_ID=$(az ad app create --display-name "$APP_DISPLAY_NAME" --query appId -o tsv)
echo "App created with appId: $APP_ID"

az ad sp create --id "$APP_ID" --query id -o tsv
```

Copy down `APP_ID` — you'll need it as a GitHub repo secret (`AZURE_CLIENT_ID`) in Phase 4.

### 3.4 Create the federated credential

This step trusts GitHub OIDC tokens issued for pushes to `main` of your repo. Without it, `azure/login@v2` cannot authenticate.

**For pushes to `main`:**

```sh
az ad app federated-credential create \
  --id "$APP_ID" \
  --parameters '{
    "name": "github-actions-main",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:'"$GITHUB_ORG"'/'"$GITHUB_REPO"':ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

If you also want to allow PR workflows to use Azure (e.g. for preview deployments — not enabled by default but possible), add a second federated credential:

```sh
# Optional, for PR workflows
az ad app federated-credential create \
  --id "$APP_ID" \
  --parameters '{
    "name": "github-actions-pr",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:'"$GITHUB_ORG"'/'"$GITHUB_REPO"':pull_request",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

The `subject` field is the most important — it pins the trust to a specific repo and ref pattern. A leak of the GitHub Actions OIDC token issued for a different repo or branch cannot be exchanged for an Azure token under this credential.

### 3.5 Grant deploy permissions

The service principal needs permission to deploy to the Functions App. Two options, in order of least-privilege:

**Option A — Website Contributor on the specific Functions App (recommended):**

```sh
az role assignment create \
  --role "Website Contributor" \
  --assignee "$APP_ID" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Web/sites/$FUNCTION_APP"
```

**Option B — Contributor on the resource group (broader, simpler):**

```sh
az role assignment create \
  --role "Contributor" \
  --assignee "$APP_ID" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP"
```

Option A is the right answer for production. Option B is acceptable if you're iterating on the Bicep templates and need the SP to create resources too.

### 3.6 Verify the setup

```sh
# Confirm the app exists
az ad app show --id "$APP_ID" --query "{displayName: displayName, appId: appId}"

# Confirm the federated credential
az ad app federated-credential list --id "$APP_ID" \
  --query "[].{name: name, subject: subject}"

# Confirm the role assignment
az role assignment list --assignee "$APP_ID" \
  --query "[].{role: roleDefinitionName, scope: scope}" -o table
```

You should see one app, at least one federated credential with the `repo:.../ref:refs/heads/main` subject, and a role assignment with scope ending in `…/sites/onshorebookings` (or the resource group, depending on which option you picked).

---

## Phase 4: Configure GitHub repo secrets

GitHub needs three identifiers to construct the OIDC token exchange. None of these are secrets in the cryptographic sense (they're public-ish identifiers that don't grant access without the OIDC token), but they're stored as repo secrets to keep them out of the workflow file.

### 4.1 Capture the three values

```sh
echo "AZURE_CLIENT_ID:       $APP_ID"
echo "AZURE_TENANT_ID:       $TENANT_ID"
echo "AZURE_SUBSCRIPTION_ID: $SUBSCRIPTION_ID"
```

### 4.2 Add them to GitHub

**Via the GitHub web UI:**

1. Navigate to your repo: `https://github.com/<org>/onshore-booking-widget`
2. Open **Settings → Secrets and variables → Actions**
3. Click **New repository secret** for each of the three values:
   - `AZURE_CLIENT_ID` — paste the `APP_ID`
   - `AZURE_TENANT_ID` — paste the tenant ID
   - `AZURE_SUBSCRIPTION_ID` — paste the subscription ID
4. After adding all three, the Repository secrets list shows three entries

**Via the `gh` CLI:**

```sh
gh secret set AZURE_CLIENT_ID --body "$APP_ID"
gh secret set AZURE_TENANT_ID --body "$TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --body "$SUBSCRIPTION_ID"
```

---

## Phase 5: Trigger the first deployment

### 5.1 Re-run the failed workflow (or push a small change)

The first push (in Phase 2) triggered a workflow run that failed because the secrets weren't yet configured. Now you can either:

**Option A — Re-run the failed workflow:**

1. Go to the **Actions** tab in your repo
2. Click the failed workflow run
3. Click **Re-run all jobs** in the top-right

**Option B — Push a no-op change:**

```sh
git commit --allow-empty -m "Trigger deployment"
git push
```

**Option C — Manually trigger:**

1. Go to **Actions → Build, Test, and Deploy**
2. Click **Run workflow** (top right) → choose `main` → **Run workflow**

### 5.2 Watch the workflow

In the Actions tab, you'll see two jobs:

1. **Build and test** — runs `npm ci`, type-check, tests, build. ~2 minutes.
2. **Deploy to Azure Functions** — runs only after build-and-test succeeds. ~2 minutes.

Each step shows real-time logs. If something fails, the logs explain why.

### 5.3 Verify deployment

After the workflow finishes successfully, the new code is live on the Functions App. Verify:

```sh
# Open the function URL and check that the widget bundle is being served
curl -I https://onshorebookings.azurewebsites.net/bookingwidget.js
# Should return 200 OK with Content-Type: application/javascript

# Test the API end-to-end with a tenant configured in BOOKING_TENANTS
curl "https://onshorebookings.azurewebsites.net/api/slots?tenant=<your-slug>" \
  -H "Origin: https://onshoreunifiedsupport.com"
# Should return JSON with a "slots" object
```

If the API returns 503, the most likely cause is that the Managed Identity hasn't been granted Microsoft Graph permissions yet — see `Infra/README.md` Step 5.

If the API returns 404 for the tenant, check that `BOOKING_TENANTS` is set on the Functions App and that the slug matches.

---

## Maintenance

### Adding additional branches that should trigger deploys

If you ever want pushes to a `staging` branch to deploy to a staging slot, add another federated credential:

```sh
az ad app federated-credential create \
  --id "$APP_ID" \
  --parameters '{
    "name": "github-actions-staging",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:<org>/<repo>:ref:refs/heads/staging",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

Then update the workflow's `if:` condition or add another job for the staging branch.

### Rotating credentials

There's nothing to rotate. The federated credential trust is established once at setup; the GitHub OIDC token is short-lived and re-issued on every workflow run. Compromise of the GitHub repo secrets (`AZURE_CLIENT_ID`, etc.) does not enable an attacker to authenticate to Azure unless they also control the GitHub repo and can cause GitHub to issue an OIDC token in its name.

### Removing the GitHub integration

To disconnect (e.g. to migrate to a different repo or to retire the integration):

```sh
# Remove the Azure AD application — this destroys the federated credentials and SP
az ad app delete --id "$APP_ID"

# Remove the GitHub repo secrets
gh secret delete AZURE_CLIENT_ID
gh secret delete AZURE_TENANT_ID
gh secret delete AZURE_SUBSCRIPTION_ID
```

---

## Troubleshooting

### Workflow fails at "Sign in to Azure" with `AADSTS70021: No matching federated identity record found`

The federated credential's `subject` does not match the GitHub OIDC token's claim. Common causes:

- Wrong organization or repository name in the `subject` (`repo:<org>/<repo>:…`)
- Wrong branch in the `subject` (must match the actual branch being pushed)
- Trying to deploy from a PR but only configured a `ref:refs/heads/main` credential — add a `pull_request` credential as shown in Phase 3.4

Inspect the OIDC token's actual claims by adding a debug step to the workflow temporarily:

```yaml
- name: Show OIDC subject
  run: |
    REQUEST_TOKEN_URL=$ACTIONS_ID_TOKEN_REQUEST_URL
    REQUEST_TOKEN=$ACTIONS_ID_TOKEN_REQUEST_TOKEN
    curl -H "Authorization: Bearer $REQUEST_TOKEN" \
      "$REQUEST_TOKEN_URL&audience=api://AzureADTokenExchange" \
      | jq -R 'split(".") | .[1] | @base64d | fromjson | .sub'
```

The output is the exact `subject` GitHub is presenting; it must match an entry in `az ad app federated-credential list`.

### Workflow fails at "Deploy to Functions App" with `Forbidden`

The service principal does not have permission on the Functions App. Re-check the role assignment from Phase 3.5:

```sh
az role assignment list --assignee "$APP_ID" -o table
```

The scope should include `…/sites/onshorebookings` or the resource group. If it doesn't, re-run the `az role assignment create` command.

### Workflow fails at `npm ci` with `lockfile not found`

`App/package-lock.json` is missing from the repo. Generate it locally (Phase 2.4) and commit:

```sh
cd App
npm install
cd ..
git add App/package-lock.json
git commit -m "Add package-lock.json"
git push
```

### Workflow fails at "Verify build artifacts" with `static/bookingwidget.js not produced`

The widget build (`build-widget.mjs`) failed silently. Run locally to see the error:

```sh
cd App
npm run build:widget
```

Common cause: a TypeScript error in `bookingwidget.ts` that esbuild surfaces as a build error rather than a type error. Fix the code and push.

### Deploy succeeds but the widget returns the old code

Two possible causes:

- **Browser/CDN cache.** The widget is served with `Cache-Control: max-age=3600`. ETag-based revalidation should pick up new content within an hour. Force-refresh with Ctrl+Shift+R on the test page.
- **Functions runtime caching.** Restart the Functions App from the Azure Portal: **Functions App → Overview → Restart**. This clears the in-process caches in `graph-client.ts` and reloads `BOOKING_TENANTS`.

### Workflow takes longer than expected

Typical run times:

- **Build and test**: 90–150 seconds (most spent on `npm ci` if cache is cold; ~30s on warm cache)
- **Deploy**: 60–120 seconds

If significantly slower, check the **Actions → Caches** tab to confirm the npm cache is being preserved between runs.

---

## Status

After Phase 5 completes successfully, automated deployment is fully operational. Subsequent code changes need only `git push origin main` to deploy.
