const BASE = `https://suitsupply.api.crowdin.com/api/v2`;

function headers() {
  return {
    Authorization: `Bearer ${process.env.CROWDIN_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export async function crowdinGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`Crowdin GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function crowdinPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Crowdin POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function crowdinDelete(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: headers() });
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    throw new Error(`Crowdin DELETE ${path} → ${res.status}: ${await res.text()}`);
  }
}

/** Upload raw content to Crowdin storage. Returns storageId. */
export async function uploadStorage(filename, content) {
  const buf = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf-8');
  const res = await fetch(`${BASE}/storages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CROWDIN_TOKEN}`,
      'Crowdin-API-FileName': filename,
      'Content-Type': 'application/json',
      'Content-Length': String(buf.length),
    },
    body: buf,
  });
  if (!res.ok) throw new Error(`Crowdin storage → ${res.status}: ${await res.text()}`);
  return (await res.json()).data.id;
}

/** List all files in the project. */
export async function listFiles(projectId) {
  const data = await crowdinGet(`/projects/${projectId}/files?limit=500`);
  return (data.data ?? []).map(f => f.data);
}

/** Create a new file in Crowdin. */
export async function createFile(projectId, storageId, name, title) {
  const data = await crowdinPost(`/projects/${projectId}/files`, {
    storageId,
    name,
    type: 'json',
    title: title ?? name,
  });
  return data.data.id;
}

/** Update an existing file's content. */
export async function updateFile(projectId, fileId, storageId) {
  const res = await fetch(`${BASE}/projects/${projectId}/files/${fileId}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ storageId, updateOption: 'keep_translations_and_approvals' }),
  });
  if (!res.ok) throw new Error(`Crowdin PUT file ${fileId} → ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}

/** Get translation progress for a file across all languages. */
export async function getFileProgress(projectId, fileId) {
  const data = await crowdinGet(`/projects/${projectId}/files/${fileId}/languages/progress?limit=50`);
  return (data.data ?? []).map(l => l.data);
}

/** Build and download translations for a file + language. Returns parsed JSON. */
export async function downloadTranslation(projectId, fileId, languageId) {
  const buildRes = await crowdinPost(`/projects/${projectId}/translations/builds/files/${fileId}`, {
    targetLanguageId: languageId,
    skipUntranslatedStrings: true,
  });
  const url = buildRes?.data?.url;
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download translation ${languageId} → ${res.status}`);
  return res.json();
}
