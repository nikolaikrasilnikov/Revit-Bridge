import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {workspaceFile,lifecycleSubmit} from '../lifecycle.mjs';
import {Manager,atomicJson} from '../core.mjs';

async function fixture(t,capabilities={saveModel:true,ifcExport:true}) {
  // Windows TEMP can use an 8.3 alias; assertions and absolute fixture paths
  // must use the same canonical root as the containment checks.
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'revit-lifecycle-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={workspaceRoot:path.join(root,'WORK'),stateRoot:path.join(root,'state')};
  await fs.mkdir(config.workspaceRoot);const manager=new Manager(config,root),sessionId=randomUUID(),documentId=randomUUID();
  const dir=manager.sessionDir(sessionId);for(const sub of ['pending','running','submitted','results'])await fs.mkdir(path.join(dir,sub),{recursive:true});
  await atomicJson(path.join(dir,'session.json'),{sessionId,pid:process.pid,heartbeatUtc:new Date().toISOString(),capabilities});
  const source=path.join(config.workspaceRoot,'Модель.rvt');await fs.writeFile(source,'RVT fixture');
  return {root,config,manager,sessionId,documentId,source,dir};
}
test('output paths support Unicode, reject escapes, missing parents and wrong types',async t=>{
  const {root,config}=await fixture(t);
  assert.equal(await workspaceFile(config,'Новая.ifc','.ifc'),path.join(config.workspaceRoot,'Новая.ifc'));
  await assert.rejects(workspaceFile(config,path.join(root,'outside.ifc'),'.ifc'),/inside/);
  await assert.rejects(workspaceFile(config,'missing/model.ifc','.ifc'));
  await assert.rejects(workspaceFile(config,'model.rvt','.ifc'),/inside/);
  await assert.rejects(workspaceFile(config,'stream:bad.ifc','.ifc'),/inside/);
  await fs.mkdir(path.join(config.workspaceRoot,'dir.ifc'));
  await assert.rejects(workspaceFile(config,'dir.ifc','.ifc'),/file/);
});
test('output and configuration junctions cannot escape WORK',async t=>{
  const {root,config}=await fixture(t);const external=path.join(root,'external');await fs.mkdir(external);
  await fs.symlink(external,path.join(config.workspaceRoot,'link'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(workspaceFile(config,'link/a.ifc','.ifc'),/Links/);
});
test('old live bridges reject persistence before any request is queued',async t=>{
  const f=await fixture(t,{});
  await assert.rejects(lifecycleSubmit(f.manager,'save_model',{sessionId:f.sessionId,documentId:f.documentId,expectedPath:f.source,authorizeSave:true}),/restart Revit/);
  assert.equal((await fs.readdir(path.join(f.dir,'pending'))).length,0);
});
test('explicit authorization and view identity are mandatory',async t=>{
  const f=await fixture(t);const a={sessionId:f.sessionId,documentId:f.documentId,expectedPath:f.source,path:path.join(f.config.workspaceRoot,'a.ifc')};
  await assert.rejects(lifecycleSubmit(f.manager,'save_model',a),/authorizeSave/);
  await assert.rejects(lifecycleSubmit(f.manager,'export_ifc',a),/authorizeExport/);
  await assert.rejects(lifecycleSubmit(f.manager,'export_ifc',{...a,authorizeExport:true,viewId:'-1'}),/viewId/);
  await assert.rejects(lifecycleSubmit(f.manager,'export_ifc',{...a,authorizeExport:true,viewId:'9223372036854775808'}),/viewId/);
});
test('save queues only the explicit document and keeps durable request idempotence',async t=>{
  const f=await fixture(t);const requestId=randomUUID();const a={sessionId:f.sessionId,documentId:f.documentId,expectedPath:f.source,authorizeSave:true,requestId};
  await lifecycleSubmit(f.manager,'save_model',a);await lifecycleSubmit(f.manager,'save_model',a);
  const files=await fs.readdir(path.join(f.dir,'pending'));assert.equal(files.length,1);
  const request=JSON.parse(await fs.readFile(path.join(f.dir,'pending',files[0]),'utf8'));
  assert.equal(request.operation,'save_model');assert.equal(request.args.documentId,f.documentId);
  assert.equal(request.args.expectedPath,f.source);assert.equal(request.args.overwrite,false);
});
test('IFC config, section-box option and exact view are carried into the fixed operation',async t=>{
  const f=await fixture(t);const cfg=path.join(f.config.workspaceRoot,'config.json');await fs.writeFile(cfg,'{}');
  const result=await lifecycleSubmit(f.manager,'export_ifc',{sessionId:f.sessionId,documentId:f.documentId,expectedPath:f.source,
    path:path.join(f.config.workspaceRoot,'a.ifc'),viewId:'37947',configurationPath:cfg,authorizeExport:true,disableSectionBox:true});
  const q=JSON.parse(await fs.readFile(path.join(f.dir,'pending',result.jobId+'.json'),'utf8'));
  assert.equal(q.args.configurationPath,cfg);assert.equal(q.args.viewId,'37947');assert.equal(q.args.disableSectionBox,true);assert.equal(q.args.overwrite,false);
});
