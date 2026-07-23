/**
 * GET /api/verify
 *
 * Finds all online vacancies in Contentful that are missing translations
 * and pushes them to Crowdin as source files.
 *
 * Run manually:   GET /api/verify
 * Scheduled:      daily via vercel.json cron
 */

import {
  extractMainFields,
  extractDescription,
  TARGET_LANGUAGES,
  LOCALE_MAP,
} from '../lib/contentful.js';
import {
  uploadStorage,
  listFiles,
  createFile,
  updateFile,
} from '../lib/crowdin.js';

const SPACE         = process.env.CONTENTFUL_SPACE_ID;
const ENV           = process.env.CONTENTFUL_ENVIRONMENT ?? 'master';
const TOKEN         = process.env.CONTENTFUL_MANAGEMENT_TOKEN;
const CONTENT_TYPE  = process.env.CONTENTFUL_CONTENT_TYPE ?? 'vacancyDetailPage';
const PROJECT_ID    = process.env.CROWDIN_PROJECT_ID ?? '23';
const CRON_SECRET   = process.env.CRON_SECRET;
const PAGE_SIZE     = 200;

export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] ?? req.headers.authorization?.replace('Bearer ', '');
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  console.log('[verify] starting verification run');

  try {
    // 1. Get existing Crowdin files for deduplication
    const existingFiles = await listFiles(PROJECT_ID);
    const byName = new Map(existingFiles.map(f => [f.name, f]));
    console.log(`[verify] ${byName.size} files already in Crowdin`);

    // 2. Fetch all online vacancies from Contentful (paginated)
    const entries = await fetchAllOnlineVacancies();
    console.log(`[verify] found ${entries.length} online vacancies in Contentful`);

    const results = { pushed: [], alreadyTranslated: [], alreadyInCrowdin: [], errors: [] };

    for (const entry of entries) {
      const entryId = entry.sys.id;
      const fields  = entry.fields ?? {};

      try {
        // 3. Check if already fully translated in Contentful
        if (isFullyTranslated(fields)) {
          results.alreadyTranslated.push(entryId);
          continue;
        }

        const mainName = `${entryId}.json`;
        const descName = `${entryId}__description.json`;
        const position = fields.position?.['en-US'] ?? entryId;
        const location = fields.location?.['en-US'] ?? '';

        // 4. Skip if already in Crowdin (being processed)
        if (byName.has(mainName)) {
          results.alreadyInCrowdin.push(entryId);
          continue;
        }

        const mainPayload = extractMainFields(fields);
        const descPayload = extractDescription(fields.description?.['en-US'] ?? fields.description?.['en']);

        if (!Object.keys(mainPayload).length) continue;

        // 5. Push to Crowdin
        const mainStorageId = await uploadStorage(mainName, mainPayload);
        await createFile(PROJECT_ID, mainStorageId, mainName, `"${position} - ${location}"`);

        if (descPayload) {
          const descStorageId = await uploadStorage(descName, descPayload);
          await createFile(PROJECT_ID, descStorageId, descName, `"${position} - ${location}" > description`);
        }

        console.log(`[verify] ✓ pushed ${entryId} (${position} @ ${location})`);
        results.pushed.push({ entryId, position, location });

      } catch (err) {
        console.error(`[verify] error on ${entryId}:`, err.message);
        results.errors.push({ entryId, error: err.message });
      }
    }

    console.log(`[verify] done — pushed: ${results.pushed.length}, already translated: ${results.alreadyTranslated.length}, already in Crowdin: ${results.alreadyInCrowdin.length}, errors: ${results.errors.length}`);
    return res.status(200).json(results);

  } catch (err) {
    console.error('[verify] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/** Fetch online vacancyDetailPage entries published in the last 6 hours. */
async function fetchAllOnlineVacancies() {
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const all = [];
  let skip = 0;

  while (true) {
    const url = `https://api.contentful.com/spaces/${SPACE}/environments/${ENV}/entries` +
      `?content_type=${CONTENT_TYPE}&fields.isOnline=true&sys.publishedAt[gte]=${since}&limit=${PAGE_SIZE}&skip=${skip}` +
      `&select=sys,fields.position,fields.location,fields.department,fields.contractType,fields.description,fields.isOnline`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`Contentful ${res.status}: ${await res.text()}`);

    const data = await res.json();
    all.push(...(data.items ?? []));

    if (all.length >= data.total || !data.items?.length) break;
    skip += PAGE_SIZE;
  }

  return all;
}

/** Returns true if all 6 target locales have a translated position field. */
function isFullyTranslated(fields) {
  const srcPos = fields.position?.['en-US'] ?? fields.position?.['en'];
  if (!srcPos) return false;
  return TARGET_LANGUAGES.every(lang => {
    const locale = LOCALE_MAP[lang];
    return typeof fields.position?.[locale] === 'string' &&
           fields.position[locale].trim() &&
           fields.position[locale] !== srcPos;
  });
}
