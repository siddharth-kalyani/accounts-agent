# Deploy the pantry to Google Cloud

This is the runbook for one Cloud Run service with Cloud SQL for PostgreSQL, a private Cloud Storage bucket and Gemini. Sign-in is email and password only for now; Microsoft (Entra) sign-in stays in the code and switches on only when all of its settings are present. Nothing here changes any other Google Cloud service. Do not upload the local database or `.env`.

## 1. What goes where

| Part of this app | Google Cloud service | Setting the app reads |
| --- | --- | --- |
| React website and FastAPI together | Cloud Run, one service, one instance | `APP_ORIGIN` |
| People, roles, sessions, pantry, chat, activity | Cloud SQL for PostgreSQL 18 (Enterprise) | `DATABASE_URL` (secret) |
| Receipt files | Cloud Storage bucket, private, versioning and soft delete on | `GCS_RECEIPTS_BUCKET` |
| Session signing key, database URL, first password | Secret Manager | attached as environment variables |
| Chat assistant and receipt reading | Gemini on Agent Platform (formerly Vertex AI) | `VERTEX_PROJECT`, `VERTEX_LOCATION`, `GEMINI_CHAT_MODEL`, `GEMINI_RECEIPT_MODEL` |
| Container build | Cloud Build and Artifact Registry, from `Dockerfile` | none |

The app identifies itself to Cloud SQL, Cloud Storage and Gemini as the Cloud Run **service account**. There are no API keys. That account needs: Cloud SQL Client, Secret Manager Secret Accessor, Agent Platform User (`roles/aiplatform.user`) on the project, and Storage Object User on the receipts bucket only.

Fill these in once and use them in every command below:

| Placeholder | Meaning |
| --- | --- |
| `PROJECT_ID` | Project ID (not the display name) |
| `PROJECT_NUMBER` | Project number from the console Dashboard |
| `REGION` | Region used for everything, for example `asia-south1` |
| `SERVICE` | Cloud Run service name, for example `inventory-agent` |
| `RUN_SA` | Service account email, for example `inventory-run@PROJECT_ID.iam.gserviceaccount.com` |
| `INSTANCE` | Cloud SQL connection name, `PROJECT_ID:REGION:INSTANCE_ID` |
| `BUCKET` | Receipts bucket name |
| `DB_URL_SECRET` | Secret Manager name holding the database URL |

The app's address is `https://SERVICE-PROJECT_NUMBER.REGION.run.app`. Cloud Run also shows an older-style address; always open the one above, because sign-in and saves only accept the address in `APP_ORIGIN`.

## 2. Console set-up (once)

1. Enable APIs: Cloud Run Admin, Cloud SQL Admin, Secret Manager, Cloud Storage, Artifact Registry, Cloud Build, Agent Platform (Vertex AI).
2. Service account with the roles in section 1.
3. Bucket: single region `REGION`, Standard, uniform access, public access prevention enforced, object versioning on (noncurrent versions kept 35 days), soft delete 35 days. No lifecycle rule that deletes live objects. Grant Storage Object User to `RUN_SA` on this bucket.
4. Cloud SQL: PostgreSQL 18, Enterprise, public IP on with **no authorized networks** (only Cloud Run's built-in connector reaches it), automated backups and point-in-time recovery on, deletion protection on. Create the database and a built-in user, then in Cloud SQL Studio, connected to that database as `postgres` (quote names that contain a hyphen):

```sql
GRANT "DB_USER" TO postgres;
ALTER DATABASE "DB_NAME" OWNER TO "DB_USER";
REVOKE ALL ON DATABASE "DB_NAME" FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO "DB_USER";
```

The app creates and upgrades its own tables at start, so its user needs these rights on its own database only.

5. Secrets, from Cloud Shell (values are generated there and never printed):

```sh
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' | gcloud secrets create session-secret --data-file=-
openssl rand -base64 18 | tr '+/' '-_' | tr -d '=\n' | gcloud secrets create bootstrap-admin-password --data-file=-
```

Create `DB_URL_SECRET` in the console with one line, URL-encoding special characters in the password:

```text
postgresql://DB_USER:PASSWORD@/DB_NAME?host=/cloudsql/INSTANCE
```

That is a Unix socket that Cloud Run provides; its connector encrypts the hop to Cloud SQL. PostgreSQL ignores `sslmode` on a socket, so the app's production TLS setting does not get in the way and must not be removed.

Keep `session-secret` stable. Changing it signs everyone out.

6. In Agent Platform, open both models once (Model Garden or Studio), accept any terms and confirm a test prompt works on the `global` endpoint. Use `VERTEX_LOCATION=global`: the `asia-south1` endpoint answered 404 for the chat model, and the assistant failed until the service was switched to `global`. `global` also costs about 10% less than a regional endpoint, but gives no control over where a request is processed; pantry data still stays in `REGION`.

## 3. Build the release (on the development PC)

From the repository root, with the suite green:

```sh
npm run build
python scripts/package_release.py
tar -czf release.tar.gz -C release .
```

`release/` holds only the Python runtime, pinned requirements, `startup.sh`, `Dockerfile` and the built website. The script refuses a nonempty `release/`; delete the old folder before packaging again. Use `tar`, not a Windows zip, so paths keep forward slashes.

## 4. Deploy (Cloud Shell)

Open Cloud Shell, choose **Upload** from its menu and upload `release.tar.gz`, then:

```sh
gcloud config set project PROJECT_ID
rm -rf release && mkdir release && tar -xzf release.tar.gz -C release
```

First deploy:

```sh
gcloud run deploy SERVICE --source release --region REGION \
  --service-account RUN_SA \
  --add-cloudsql-instances INSTANCE \
  --set-secrets "SESSION_SECRET=session-secret:latest,DATABASE_URL=DB_URL_SECRET:latest,BOOTSTRAP_SUPERADMIN_PASSWORD=bootstrap-admin-password:latest" \
  --set-env-vars "APP_ENV=production,APP_ORIGIN=https://SERVICE-PROJECT_NUMBER.REGION.run.app,GCS_RECEIPTS_BUCKET=BUCKET,VERTEX_PROJECT=PROJECT_ID,VERTEX_LOCATION=global,GEMINI_CHAT_MODEL=gemini-3.1-flash-lite,GEMINI_RECEIPT_MODEL=gemini-3.8-flash" \
  --min-instances 1 --max-instances 1 --no-cpu-throttling \
  --cpu 1 --memory 1Gi --timeout 300 \
  --allow-unauthenticated
```

Why these flags:

- One instance, always on, CPU not throttled: rate limits and the database lock are per process, and receipt reading continues in the background after the upload request returns.
- `--allow-unauthenticated`: the app does its own sign-in. Do not put Google sign-in (IAP) in front of it.
- The first deploy asks to create an Artifact Registry repository for source builds; answer yes. If the build stops on a permission error for a build service account, send the exact message to the project administrator rather than granting broad roles.

Check it: `curl https://SERVICE-PROJECT_NUMBER.REGION.run.app/api/health` returns `{"ok":true}`. Health checks only the database, not storage or Gemini. If start-up fails, read Cloud Run → Logs; the app refuses to start when a production setting is missing or wrong. Fix the setting; never switch the checks off.

## 5. First sign-in, then retire the one-time password

1. Read the password once: Secret Manager → `bootstrap-admin-password` → Versions → View secret value (or `gcloud secrets versions access latest --secret=bootstrap-admin-password`). Do not paste it anywhere.
2. Open the app, sign in as the seeded Super Admin (`SEED_SUPERADMIN_EMAIL`, default `Siddharth.Kalyani@intuitive.AI`) with that password and choose a new one. The rules are the same as an invite: it works for seven days and must be changed at first sign-in.
3. Remove it from the service, then delete it:

```sh
gcloud run services update SERVICE --region REGION --remove-secrets BOOTSTRAP_SUPERADMIN_PASSWORD
gcloud secrets delete bootstrap-admin-password
```

If the seven days pass before anyone signs in, restart the service with the secret still attached: on a fresh install whose only person has never chosen a password, the app re-arms it. Once that person has chosen a password, or anyone else exists, the secret does nothing. Production without Microsoft sign-in refuses to start on an empty database without this secret.

Then invite at least one more trusted Super Admin from Access, so the pantry never depends on one account.

## 6. Later releases: automatic from `main`

Every push to `main` runs the `verify` job in `.github/workflows/checks.yml`. When it passes, the `deploy` job takes that job's `release/` artifact, builds the image on the GitHub runner, pushes it to the Artifact Registry repository `inventory-agent` (tagged with the commit SHA) and deploys it to the `inventory-agent` service with `--image` only. Settings and secrets on the service are never changed by a deploy; change them with `gcloud run services update ... --update-env-vars` (never `--set-env-vars`, which replaces the whole list). Branches and pull requests run the checks but never deploy. Work on a branch and merge to `main` to release.

Cloud Run starts the new revision beside the old one and moves traffic only after it is healthy, so the site stays up. A new revision that fails to start gets no traffic. Each deploy restarts the app, so a receipt being read at that moment can be cut off and must be uploaded again. The new revision upgrades the database schema at start while the old one is still serving.

GitHub signs in with Workload Identity Federation: a short-lived Google token, no JSON key. It is accepted only for `siddharth-kalyani/accounts-agent` on `refs/heads/main`, as the `inventory-deployer` service account, which can only push to the `inventory-agent` repository, deploy the `inventory-agent` service, and run it as `inventory-run`.

One-time set-up in Cloud Shell, with the project selected. It first checks that each name is free or already belongs to this app, stops otherwise, creates only what is missing and only adds IAM bindings:

```sh
bash <<'EOF'
set -euo pipefail
PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
[ -n "$PROJECT_ID" ] || { echo "Select the project first: gcloud config set project PROJECT_ID"; exit 1; }
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
REGION=asia-south1; SERVICE=inventory-agent; REPOSITORY=inventory-agent
RUN_SA="inventory-run@$PROJECT_ID.iam.gserviceaccount.com"
DEPLOY_SA="inventory-deployer@$PROJECT_ID.iam.gserviceaccount.com"
POOL=inventory-agent-github; PROVIDER=github; GITHUB_REPO=siddharth-kalyani/accounts-agent
LABEL="inventory-agent GitHub deploys"
echo "Project $PROJECT_ID"

# Read-only checks first.
gcloud run services describe "$SERVICE" --region "$REGION" --format='value(metadata.name)'
gcloud iam service-accounts describe "$RUN_SA" --format='value(email)'
repo=$(gcloud artifacts repositories describe "$REPOSITORY" --location "$REGION" --format='value(format)' 2>/dev/null || true)
[ -z "$repo" ] || [ "$repo" = DOCKER ] || { echo "Repository $REPOSITORY exists and is not Docker. Stopped."; exit 1; }
account=$(gcloud iam service-accounts describe "$DEPLOY_SA" --format='value(displayName)' 2>/dev/null || true)
[ -z "$account" ] || [ "$account" = "$LABEL" ] || { echo "$DEPLOY_SA belongs to something else. Stopped."; exit 1; }
pool=$(gcloud iam workload-identity-pools describe "$POOL" --location global --format='csv[no-heading](displayName,state)' 2>/dev/null || true)
[ -z "$pool" ] || [ "$pool" = "$LABEL,ACTIVE" ] || { echo "Pool $POOL exists and is not ours or not active. Stopped."; exit 1; }
provider=""
[ -z "$pool" ] || provider=$(gcloud iam workload-identity-pools providers describe "$PROVIDER" --location global --workload-identity-pool "$POOL" --format='value(state)' 2>/dev/null || true)
[ -z "$provider" ] || [ "$provider" = ACTIVE ] || { echo "Provider $PROVIDER is $provider. Stopped."; exit 1; }

# Create only what is missing.
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com artifactregistry.googleapis.com
[ -n "$repo" ] || gcloud artifacts repositories create "$REPOSITORY" --location "$REGION" --repository-format docker --description "$LABEL"
if [ -z "$account" ]; then gcloud iam service-accounts create inventory-deployer --display-name "$LABEL"; sleep 15; fi
[ -n "$pool" ] || gcloud iam workload-identity-pools create "$POOL" --location global --display-name "$LABEL"
[ -n "$provider" ] || gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location global --workload-identity-pool "$POOL" \
  --display-name GitHub --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref' \
  --attribute-condition "assertion.repository == '$GITHUB_REPO' && assertion.ref == 'refs/heads/main'"

# Add bindings on our own resources only.
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role roles/iam.workloadIdentityUser --format none \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$GITHUB_REPO"
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" --role roles/iam.serviceAccountUser --member "serviceAccount:$DEPLOY_SA" --format none
gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" --location "$REGION" --role roles/artifactregistry.writer --member "serviceAccount:$DEPLOY_SA" --format none
gcloud run services add-iam-policy-binding "$SERVICE" --region "$REGION" --role roles/run.developer --member "serviceAccount:$DEPLOY_SA" --format none

echo; echo "Add these in GitHub as repository variables:"
echo "GCP_PROJECT_ID=$PROJECT_ID"
echo "GCP_WORKLOAD_IDENTITY_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
echo "GCP_DEPLOY_SERVICE_ACCOUNT=$DEPLOY_SA"
EOF
```

Then in GitHub open the repository → Settings → Secrets and variables → Actions → **Variables** and add the three values it prints. They are identifiers, not secrets. Until they exist the deploy job fails with a message naming them; after adding them, re-run that job from the Actions tab. If an organization policy refuses the pool or the `principalSet` member, send the exact message to the project administrator rather than using a service account key.

To deploy by hand without GitHub (for example while GitHub is down), package as in section 3 and run `gcloud run deploy SERVICE --source release --region REGION` in Cloud Shell.

## 7. Staging checks before people rely on it

- Sign in, choose a password, sign out and back in. Five wrong passwords lock the account for 15 minutes; do not test that on the only Super Admin.
- In browser developer tools, `aim_access` and `aim_refresh` are HttpOnly, Secure and SameSite=Lax.
- Add an office, record a purchase with a receipt, download it back, read a receipt with the assistant, and ask the assistant a stock question. A purchase must survive a receipt that fails to upload.
- Gemini check: the OpenAI-compatible endpoint is expected to accept forced tool calls (receipt reading forces `submit_receipt`) and streamed tool calls. If receipt reading or chat fails, Cloud Run logs show `Receipt model upstream failed (400)` or `Assistant upstream failed (400)`; report the status code.
- Client address check: the app takes the caller's address from the last `X-Forwarded-For` entry that Google's front end appends. If an external load balancer is ever added in front, set `PANTRY_PROXY_HOPS=2`.
- Restart the service (deploy again, or edit and save the service) and confirm you are still signed in.
- Confirm the bucket refuses anonymous access.

## 8. Operations and recovery

- Cloud SQL backups and point-in-time recovery cover the database; bucket versioning and soft delete cover receipts. Database backups do not include receipt files. A point-in-time restore creates a new instance: rehearse it once into a separate instance and point a test service at it.
- For a bad code release, send traffic back to the previous revision: `gcloud run revisions list --service SERVICE --region REGION`, then `gcloud run services update-traffic SERVICE --region REGION --to-revisions REVISION=100`. Fix on a branch and merge; the next deploy moves traffic to the newest revision again. Reverting the commit on `main` also redeploys the older code. Do not restore the database to roll back code.
- When someone leaves, a Super Admin turns them off in the app immediately; that revokes every session.
- Keep two active Super Admins. Do not raise `--max-instances` without replacing the per-process rate limits and load-testing the database lock.
- Model ids retire: `GEMINI_CHAT_MODEL` and `GEMINI_RECEIPT_MODEL` can be changed with `gcloud run services update SERVICE --region REGION --update-env-vars GEMINI_CHAT_MODEL=...` and need no code change. Gemini 3.8 Flash has introductory pricing until 31 December 2026.
