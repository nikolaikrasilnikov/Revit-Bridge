import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../config.mjs';

test('configuration resolves relative paths against the package, including Unicode', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'revit-config-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const config = {workspaceRoot:'./Модели',stateRoot:'./state',autodeskRoot:'./Autodesk',supportedVersions:['2025','2026']};
  await fs.writeFile(path.join(root,'config.example.json'), JSON.stringify(config));
  assert.equal((await loadConfig(root)).workspaceRoot, path.join(root,'Модели'));
  await fs.writeFile(path.join(root,'config.json'), '\uFEFF' + JSON.stringify({...config,workspaceRoot:'./Custom'}));
  assert.equal((await loadConfig(root)).workspaceRoot, path.join(root,'Custom'));
});

test('invalid JSON and unsupported versions are not silently accepted', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'revit-config-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const file = path.join(root,'config.json');
  await fs.writeFile(file,'{broken');
  await assert.rejects(loadConfig(root),SyntaxError);
  await fs.writeFile(file,JSON.stringify({workspaceRoot:'.',stateRoot:'.',autodeskRoot:'.',supportedVersions:['2021']}));
  await assert.rejects(loadConfig(root),/2025/);
});
