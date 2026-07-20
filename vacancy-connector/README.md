# Vacancy Connector

Contentful ↔ Crowdin vacancy connector. No database, no OAuth, no complex pipeline.

## How it works

```
Bobby publishes vacancy in Contentful
  → Contentful webhook → POST /api/contentful-webhook
  → Creates source files in Crowdin (entryId.json + entryId__description.json)

Cowork hourly skill → translates + approves all strings in Crowdin

Vercel cron (every hour at :30) → GET /api/sync-back
  → Finds Crowdin files at 100% translated
  → Downloads translations for all 6 languages
  → Updates + publishes Contentful entry with all locales

Cowork daily skill → deletes finished Crowdin files
```

## Deploy

```bash
cd vacancy-connector
vercel --prod
```

## Environment variables

Set in Vercel → Project → Settings → Environment Variables:

| Variable | Value |
|---|---|
| `CONTENTFUL_SPACE_ID` | `vl9y3jevt475` |
| `CONTENTFUL_MANAGEMENT_TOKEN` | Your Contentful management token |
| `CONTENTFUL_ENVIRONMENT` | `master` |
| `CONTENTFUL_CONTENT_TYPE` | `vacancyDetailPage` |
| `CROWDIN_TOKEN` | Your Crowdin personal access token |
| `CROWDIN_PROJECT_ID` | `23` |
| `WEBHOOK_SECRET` | Random string (used to verify Contentful webhook) |
| `CRON_SECRET` | Random string (used to verify cron calls) |

## Contentful webhook setup

In Contentful → Settings → Webhooks → Add webhook:

| Field | Value |
|---|---|
| URL | `https://<your-vercel-url>/api/contentful-webhook` |
| Triggers | Entry → Publish |
| Headers | `X-Webhook-Secret: <WEBHOOK_SECRET>` |
| Content type filter | `vacancyDetailPage` (optional but recommended) |

## Disable the official Crowdin connector

Go to the Crowdin ↔ Contentful connector and set Sync schedule to **Disabled**.
This connector replaces it.
