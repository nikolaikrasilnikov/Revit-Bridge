import fs from 'node:fs/promises';
import path from 'node:path';
import { inside, modelPath } from './core.mjs';

export async function workspaceFile(config, input, extension, mustExist = false) {
  if (typeof input !== 'string' || !input) throw new Error('An explicit file path is required');
  const root = await fs.realpath(config.workspaceRoot), full = path.resolve(root, input);
  if (!inside(root, full) || path.extname(full).toLowerCase() !== extension ||
      path.relative(root, full).split(path.sep).some(s => /[:<>"|?*]/.test(s) || /[. ]$/.test(s)))
    throw new Error(`Expected ${extension} inside workspaceRoot`);
  let current = root;
  const segments = path.relative(root, full).split(path.sep);
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) throw new Error('Links and junctions are not allowed');
      if (i < segments.length - 1 && !st.isDirectory()) throw new Error('Output parent is not a directory');
      if (i === segments.length - 1 && !st.isFile()) throw new Error('Expected a file');
    } catch (error) {
      if (error.code !== 'ENOENT' || mustExist || i !== segments.length - 1) throw error;
    }
  }
  return full;
}

export async function lifecycleSubmit(manager, operation, a) {
  const args = { documentId:a.documentId, expectedPath:a.expectedPath === '' ? '' : await modelPath(manager.config,a.expectedPath),
    workflowId:a.workflowId, overwrite:a.overwrite === true };
  if (operation === 'save_model') {
    if (a.authorizeSave !== true) throw new Error('authorizeSave:true is required for an explicitly requested save');
    args.authorizeSave=true;
    if (a.path) args.path=await workspaceFile(manager.config,a.path,'.rvt');
  } else if (operation === 'export_ifc') {
    if (a.authorizeExport !== true) throw new Error('authorizeExport:true is required for an explicitly requested IFC export');
    args.authorizeExport=true;
    args.path=await workspaceFile(manager.config,a.path,'.ifc');
    args.configurationPath=a.configurationPath ? await workspaceFile(manager.config,a.configurationPath,'.json',true) : null;
    if (!/^[1-9]\d{0,18}$/.test(a.viewId ?? '') || BigInt(a.viewId)>9223372036854775807n) throw new Error('An explicit 3D viewId is required');
    args.viewId=a.viewId; args.disableSectionBox=a.disableSectionBox === true;
  } else throw new Error('Unsupported lifecycle operation');
  const session=await manager.requireSession(a.sessionId);
  if (!session.capabilities?.[operation === 'save_model' ? 'saveModel' : 'ifcExport'])
    throw new Error('This Revit process uses an older bridge. Save your open documents and restart Revit to load bridge 0.5.0; no operation was submitted.');
  return manager.submit(a.sessionId,operation,args,a.requestId);
}
