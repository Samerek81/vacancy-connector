/**
 * POST /api/contentful-webhook
 *
 * Receives Contentful "Entry published" webhook events.
 * For vacancyDetailPage entries, creates/updates the source file in Crowdin.
 *
 * Set in Contentful:
 *   URL:    https://<your-vercel-url>/api/contentful-webhook
 *   Events: Entry → Publish
 *   Header: X-Webhook-Secret: <WEBHOOK_SECRET env var>
 */

import {
  extractMainFields,
  extractDescription,
  getEntry,
} from '../lib/contentful.js';
import {
  uploadStorage,
  listFiles,
  createFile,
  updateFile,
} from '../lib/crowdin.js';

const PROJECT_ID     = process.env.CROWDIN_PROJECT_ID ?? '23';
const CONTENT_TYPE   = process.env.CONTENTFUL_CONTENT_TYPE ?? 'vacancyDetailPage';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Verify secret
  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }

  const body = req.body ?? {};
  const entryId = body?.sys?.id ?? body?.entityId;
  const contentType = body?.sys?.contentType?.sys?.id ?? body?.contentTypeId;

  if (!entryId) {
    return res.status(400).json({ error: 'missing entry id' });
  }

  // Only process vacancy entries
  if (contentType && contentType !== CONTENT_TYPE) {
    return res.status(200).json({ skipped: true, reason: 'not-a-vacancy' });
  }

  console.log(`[contentful-webhook] received publish for ${entryId}`);

  try {
    await processEntry(entryId);
    return res.status(200).json({ ok: true, entryId });
  } catch (err) {
    console.error(`[contentful-webhook] error processing ${entryId}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function processEntry(entryId) {
  // Fetch fresh entry from Contentful
  const entry = await getEntry(entryId);
  const contentType = entry.sys.contentType?.sys?.id;

  if (contentType !== CONTENT_TYPE) {
    console.log(`[contentful-webhook] ${entryId} is ${contentType}, skipping`);
    return;
  }

  const fields = entry.fields ?? {};

  // Only process online vacancies — support both 'en' and 'en-US' source locales
  const isOnline = fields.isOnline?.['en-US'] ?? fields.isOnline?.['en'];
  if (isOnline !== true) {
    console.log(`[contentful-webhook] ${entryId} is not online — skipping`);
    return;
  }

  // Loop guard — if translations already exist this publish was triggered by
  // our own sync-back. Skip to prevent an infinite loop.
  const TARGET_LOCALES = ['de', 'fr', 'es', 'it', 'ko', 'zh'];
  const srcPosition = fields.position?.['en-US'] ?? fields.position?.['en'];
  const hasTranslations = srcPosition && TARGET_LOCALES.some(locale =>
    typeof fields.position?.[locale] === 'string' && fields.position[locale].trim() &&
    fields.position[locale] !== srcPosition
  );
  if (hasTranslations) {
    console.log(`[contentful-webhook] ${entryId} already has translations — skipping (loop guard)`);
    return;
  }

  const mainPayload = extractMainFields(fields);
  const descPayload = extractDescription(fields.description?.['en-US']);

  if (!Object.keys(mainPayload).length) {
    console.log(`[contentful-webhook] ${entryId} has no translatable fields, skipping`);
    return;
  }

  // Check existing Crowdin files for dedup
  const existingFiles = await listFiles(PROJECT_ID);
  const byName = new Map(existingFiles.map(f => [f.name, f]));

  const mainName = `${entryId}.json`;
  const descName = `${entryId}__description.json`;
  const position = fields.position?.['en-US'] ?? entryId;
  const location = fields.location?.['en-US'] ?? '';

  // Upload main fields
  const mainStorageId = await uploadStorage(mainName, mainPayload);
  if (byName.has(mainName)) {
    await updateFile(PROJECT_ID, byName.get(mainName).id, mainStorageId);
    console.log(`[contentful-webhook] updated ${mainName}`);
  } else {
    await createFile(PROJECT_ID, mainStorageId, mainName, `"${position} - ${location}"`);
    console.log(`[contentful-webhook] created ${mainName}`);
  }

  // Upload description (if present)
  if (descPayload) {
    const descStorageId = await uploadStorage(descName, descPayload);
    if (byName.has(descName)) {
      await updateFile(PROJECT_ID, byName.get(descName).id, descStorageId);
      console.log(`[contentful-webhook] updated ${descName}`);
    } else {
      await createFile(PROJECT_ID, descStorageId, descName, `"${position} - ${location}" > description`);
      console.log(`[contentful-webhook] created ${descName}`);
    }
  }

  console.log(`[contentful-webhook] ✓ ${entryId} (${position} @ ${location}) pushed to Crowdin`);
}
