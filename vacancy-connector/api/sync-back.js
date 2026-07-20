/**
 * GET /api/sync-back
 *
 * Vercel cron — runs every hour.
 * Finds Crowdin files where all 6 languages are 100% translated,
 * pulls the translations, and writes them back to Contentful.
 *
 * The cleanup skill handles Crowdin file deletion separately.
 */

import {
  LOCALE_MAP,
  TARGET_LANGUAGES,
  getEntry,
  updateEntry,
  publishEntry,
  applyTranslation,
} from '../lib/contentful.js';
import {
  listFiles,
  getFileProgress,
  downloadTranslation,
} from '../lib/crowdin.js';

const PROJECT_ID  = process.env.CROWDIN_PROJECT_ID ?? '23';
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  // Verify cron secret
  const secret = req.headers['x-cron-secret'] ?? req.headers.authorization?.replace('Bearer ', '');
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  console.log('[sync-back] starting sync-back run');

  try {
    const files = await listFiles(PROJECT_ID);
    if (!files.length) {
      return res.status(200).json({ message: 'No files in Crowdin', synced: 0 });
    }

    // Group files by entryId (main file + optional description file)
    const groups = groupByEntry(files);
    console.log(`[sync-back] found ${groups.size} vacancy entries in Crowdin`);

    const results = { synced: [], skipped: [], errors: [] };

    for (const [entryId, group] of groups) {
      try {
        const result = await syncEntry(entryId, group);
        if (result.synced) {
          results.synced.push({ entryId, locales: result.locales });
        } else {
          results.skipped.push({ entryId, reason: result.reason });
        }
      } catch (err) {
        console.error(`[sync-back] error syncing ${entryId}:`, err.message);
        results.errors.push({ entryId, error: err.message });
      }
    }

    console.log(`[sync-back] done — synced: ${results.synced.length}, skipped: ${results.skipped.length}, errors: ${results.errors.length}`);
    return res.status(200).json(results);

  } catch (err) {
    console.error('[sync-back] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/** Group Crowdin files by entryId. Returns Map<entryId, { mainFile, descFile }>. */
function groupByEntry(files) {
  const groups = new Map();
  for (const file of files) {
    const name = file.name;
    // Skip files that don't look like vacancy files
    if (!name.endsWith('.json')) continue;

    const isDesc = name.includes('__description');
    const entryId = isDesc
      ? name.replace('__description.json', '')
      : name.replace('.json', '');

    // Skip malformed names (entry IDs are ~22 chars, alphanumeric)
    if (entryId.length < 10 || entryId.includes('/')) continue;

    if (!groups.has(entryId)) groups.set(entryId, { mainFile: null, descFile: null });
    const group = groups.get(entryId);
    if (isDesc) group.descFile = file;
    else group.mainFile = file;
  }
  return groups;
}

/** Sync one entry: check progress, download translations, update Contentful. */
async function syncEntry(entryId, { mainFile, descFile }) {
  if (!mainFile) {
    return { synced: false, reason: 'no-main-file' };
  }

  // Check translation progress for main file
  const progress = await getFileProgress(PROJECT_ID, mainFile.id);
  const byLang = new Map(progress.map(p => [p.languageId, p]));

  // Only sync when all target languages are fully translated
  const allComplete = TARGET_LANGUAGES.every(lang => {
    const p = byLang.get(lang);
    return p && p.translationProgress === 100;
  });

  if (!allComplete) {
    const incomplete = TARGET_LANGUAGES.filter(lang => {
      const p = byLang.get(lang);
      return !p || p.translationProgress < 100;
    });
    return { synced: false, reason: `incomplete: ${incomplete.join(', ')}` };
  }

  // Download translations for all languages
  const translations = {};
  for (const lang of TARGET_LANGUAGES) {
    const [mainTrans, descTrans] = await Promise.all([
      downloadTranslation(PROJECT_ID, mainFile.id, lang),
      descFile ? downloadTranslation(PROJECT_ID, descFile.id, lang) : null,
    ]);
    translations[lang] = { main: mainTrans, desc: descTrans };
  }

  // Apply translations to Contentful entry with retry on version conflict
  const MAX_ATTEMPTS = 8;
  let entry = await getEntry(entryId);
  const updatedLocales = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let changed = false;
    for (const lang of TARGET_LANGUAGES) {
      const locale = LOCALE_MAP[lang];
      const { main, desc } = translations[lang];
      if (applyTranslation(entry, locale, main, desc)) {
        changed = true;
        if (!updatedLocales.includes(locale)) updatedLocales.push(locale);
      }
    }

    if (!changed) {
      console.log(`[sync-back] ${entryId} — already up to date`);
      return { synced: false, reason: 'no-changes' };
    }

    try {
      const updated = await updateEntry(entryId, entry);
      await publishEntry(entryId, updated.sys.version);
      console.log(`[sync-back] ✓ ${entryId} published locales: ${updatedLocales.join(', ')}`);
      return { synced: true, locales: updatedLocales };
    } catch (err) {
      if (err.status === 409 && attempt < MAX_ATTEMPTS) {
        // Version conflict — re-fetch and retry
        await new Promise(r => setTimeout(r, 200 * attempt));
        entry = await getEntry(entryId);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to update ${entryId} after ${MAX_ATTEMPTS} attempts`);
}
