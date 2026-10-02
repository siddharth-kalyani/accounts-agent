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

6. In Agent Platform, open both models once (Model Garden or Studio), accept any terms and confirm a test prompt works in `REGION`. Regional endpoints cost about 10% more than `global` for Gemini 3 models; `global` gives no control over where a request is processed.

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
  --set-env-vars "APP_ENV=production,APP_ORIGIN=https://SERVICE-PROJECT_NUMBER.REGION.run.app,GCS_RECEIPTS_BUCKET=BUCKET,VERTEX_PROJECT=PROJECT_ID,VERTEX_LOCATION=REGION,GEMINI_CHAT_MODEL=gemini-3.1-flash-lite,GEMINI_RECEIPT_MODEL=gemini-3.8-flash" \
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

## 6. Later releases

Package again (section 3), upload, extract, and run only:

```sh
gcloud run deploy SERVICE --source release --region REGION
```

Settings not named on the command line are kept. Each deploy restarts the single instance, so release at a quiet time.

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
- For a bad code release, deploy the previous `release.tar.gz` again. Do not restore the database to roll back code.
- When someone leaves, a Super Admin turns them off in the app immediately; that revokes every session.
- Keep two active Super Admins. Do not raise `--max-instances` without replacing the per-process rate limits and load-testing the database lock.
- Model ids retire: `GEMINI_CHAT_MODEL` and `GEMINI_RECEIPT_MODEL` can be changed with `gcloud run services update SERVICE --region REGION --update-env-vars GEMINI_CHAT_MODEL=...` and need no code change. Gemini 3.8 Flash has introductory pricing until 31 December 2026.
