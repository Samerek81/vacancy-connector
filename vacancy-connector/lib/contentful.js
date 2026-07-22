const SPACE = process.env.CONTENTFUL_SPACE_ID;
const ENV   = process.env.CONTENTFUL_ENVIRONMENT ?? 'master';
const TOKEN = process.env.CONTENTFUL_MANAGEMENT_TOKEN;
const BASE  = `https://api.contentful.com/spaces/${SPACE}/environments/${ENV}`;

function headers(version) {
  const h = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/vnd.contentful.management.v1+json',
  };
  if (version !== undefined) h['X-Contentful-Version'] = String(version);
  return h;
}

export async function getEntry(entryId) {
  const res = await fetch(`${BASE}/entries/${entryId}`, { headers: headers() });
  if (!res.ok) throw new Error(`Contentful GET ${entryId} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function updateEntry(entryId, entry) {
  const version = entry.sys.version;
  const res = await fetch(`${BASE}/entries/${entryId}`, {
    method: 'PUT',
    headers: headers(version),
    body: JSON.stringify(entry),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Contentful PUT ${entryId} → ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function publishEntry(entryId, version) {
  const res = await fetch(`${BASE}/entries/${entryId}/published`, {
    method: 'PUT',
    headers: headers(version),
  });
  if (!res.ok) throw new Error(`Contentful publish ${entryId} → ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Map Crowdin language codes → Contentful locale keys */
export const LOCALE_MAP = {
  de: 'de',
  fr: 'fr',
  es: 'es',
  it: 'it',
  ko: 'ko',
  'zh-CN': 'zh',
};

export const TARGET_LANGUAGES = Object.keys(LOCALE_MAP);

/** Get value from a field supporting both 'en' and 'en-US' source locales. */
function enVal(field) {
  return field?.['en-US'] ?? field?.['en'];
}

/**
 * Extract translatable fields from an entry's EN fields.
 * Returns { position, location, department, contractType } (strings only).
 */
export function extractMainFields(fields) {
  const result = {};
  for (const key of ['position', 'location', 'department', 'contractType']) {
    const v = enVal(fields[key]);
    if (typeof v === 'string' && v.trim()) result[key] = v.trim();
  }
  return result;
}

/**
 * Extract Rich Text description into a flat { "0": text, "1": text, ... } map.
 * Preserves bold markers using <strong> tags.
 */
export function extractDescription(rtNode, nodes = []) {
  if (!rtNode) return null;
  _collectNodes(rtNode, nodes);
  if (!nodes.length) return null;
  const payload = {};
  nodes.forEach((n, i) => {
    payload[String(i)] = n.bold ? `<strong>${n.text}</strong>` : n.text;
  });
  return payload;
}

function _collectNodes(node, out) {
  if (node.nodeType === 'text' && node.value?.trim()) {
    out.push({ text: node.value, bold: node.marks?.some(m => m.type === 'bold') ?? false });
  }
  if (node.content) {
    for (const child of node.content) _collectNodes(child, out);
  }
}

/**
 * Rebuild Rich Text from a translated { "0": text, "1": text } map.
 * Deep-clones the original EN Rich Text structure and replaces text values.
 */
export function rebuildRichText(originalRt, translationMap) {
  const cloned = JSON.parse(JSON.stringify(originalRt));
  const counter = { i: 0 };
  _replaceNodes(cloned, translationMap, counter);
  return cloned;
}

function _replaceNodes(node, map, counter) {
  if (node.nodeType === 'text' && node.value?.trim()) {
    const raw = map[String(counter.i)];
    if (raw !== undefined) {
      // Strip <strong> wrapper — bold is preserved via marks, not tag
      node.value = raw.replace(/^<strong>|<\/strong>$/g, '');
    }
    counter.i++;
  }
  if (node.content) {
    for (const child of node.content) _replaceNodes(child, map, counter);
  }
}

/**
 * Apply a translation payload (from Crowdin) to a Contentful entry in-place.
 * Handles both main fields and description rich text.
 * Returns true if any field was changed.
 */
export function applyTranslation(entry, locale, mainPayload, descPayload) {
  let changed = false;
  const fields = entry.fields;

  // Main scalar fields
  for (const key of ['position', 'location', 'department', 'contractType']) {
    const v = mainPayload?.[key];
    if (typeof v === 'string' && v.trim()) {
      if (fields[key]?.[locale] !== v) {
        if (!fields[key]) fields[key] = {};
        fields[key][locale] = v;
        changed = true;
      }
    }
  }

  // Rich Text description
  if (descPayload && (fields.description?.['en-US'] || fields.description?.['en'])) {
    const srcRt = fields.description?.['en-US'] ?? fields.description?.['en'];
    const rebuilt = rebuildRichText(srcRt, descPayload);
    if (!fields.description[locale]) {
      fields.description[locale] = rebuilt;
      changed = true;
    } else {
      // Only update if content differs (avoid spurious publishes)
      const existing = JSON.stringify(fields.description[locale]);
      const rebuilt_ = JSON.stringify(rebuilt);
      if (existing !== rebuilt_) {
        fields.description[locale] = rebuilt;
        changed = true;
      }
    }
  }

  return changed;
}
