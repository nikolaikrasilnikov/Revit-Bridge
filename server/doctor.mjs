import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { Manager, installations } from './core.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const exists = async p => fs.access(p).then(() => true, () => false);
const config = await loadConfig(root);
const manager = new Manager(config, root);
const report = {
  product: 'Revit Bridge', node: process.version, platform: process.platform,
  toolset: process.env.REVIT_BRIDGE_TOOLSET ?? 'code',
  configured: await exists(path.join(root, 'config.json')),
  workspaceExists: await exists(config.workspaceRoot),
  installations: await installations(config),
  builds: await Promise.all(config.supportedVersions.map(async year => ({year, present: await exists(path.join(root, 'bin', year, 'RevitWorkspaceBridge.dll'))}))),
  sessions: await manager.sessions({includeUnavailable: false})
};
console.log(JSON.stringify(report, null, 2));
if (!report.configured || !report.workspaceExists) process.exitCode = 1;
