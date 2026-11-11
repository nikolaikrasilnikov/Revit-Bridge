import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadConfig(root) {
  const file = path.join(root, 'config.json');
  let data;
  try { data = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = JSON.parse((await fs.readFile(path.join(root, 'config.example.json'), 'utf8')).replace(/^\uFEFF/, ''));
  }
  for (const key of ['workspaceRoot', 'stateRoot', 'autodeskRoot']) {
    if (typeof data[key] !== 'string' || !data[key].trim()) throw new Error(`Missing configuration: ${key}`);
    data[key] = path.resolve(root, data[key]);
  }
  if (!Array.isArray(data.supportedVersions) || !data.supportedVersions.length || data.supportedVersions.some(y => !['2025', '2026'].includes(y))) {
    throw new Error('supportedVersions must contain Revit 2025 and/or 2026');
  }
  return data;
}
