import path from 'node:path';
import {readJson} from './core.mjs';

// Suggestions are explicitly heuristic; the original failure GUID/text remains authoritative.
export function warningAdvice(description='') {
  if (/overlap|identical|duplicate|перекрыва|совпада|дублир/i.test(description)) return {
    category:'overlap_or_duplicate',
    suggestion:'Проверить координаты и уже созданные элементы по ID/UniqueId; исключить повторную постановку. Подготовить исправленные входные данные перед новой порцией.'};
  if (/enclos|room|area|помещен|зон|границ/i.test(description)) return {
    category:'spatial_boundary',
    suggestion:'Проверить уровень, фазу, замыкание и пересечения границ только затронутых помещений/зон.'};
  if (/join|intersect|соедин|пересеч/i.test(description)) return {
    category:'join_or_intersection',
    suggestion:'Проверить геометрию и соединения указанных элементов; сократить порцию до одного элемента для локализации.'};
  if (/constraint|dimension|огранич|размер|зависим/i.test(description)) return {
    category:'constraint',
    suggestion:'Проверить зависимости, закрепление, размеры и допустимые параметры затронутых элементов.'};
  return {category:'unclassified',suggestion:'Прочитать исходный текст и элементы; проверить текущую модель перед исправлением. Автоматического исправления геометрии нет.'};
}

export function analyzeWarnings(events,jobId) {
  const selected=events.filter(e=>!jobId||e.jobId===jobId), groups=new Map();
  // The transaction preprocessor and global event can see the same failure. Prefer
  // preprocessor records per job so the report does not double count that cycle.
  const managed=new Set(selected.filter(e=>e.kind==='transaction_failure').map(e=>e.jobId));
  for(const e of selected) {
    if(e.kind!=='transaction_failure' && (e.kind!=='failure'||managed.has(e.jobId)))continue;
    const d=e.data??{}, key=JSON.stringify([d.documentId,d.failureId,d.severity]);
    let g=groups.get(key);
    if(!g){g={documentId:d.documentId,failureId:d.failureId,severity:d.severity,description:d.description,
      occurrences:0,elements:new Set(),additionalElements:new Set(),jobIds:new Set(),
      automaticAction:d.automaticAction??'recorded_only',...warningAdvice(d.description)};groups.set(key,g);}
    g.occurrences++;g.lastUtc=e.utc;
    for(const id of d.elements??[])g.elements.add(String(id));
    for(const id of d.additionalElements??[])g.additionalElements.add(String(id));
    if(e.jobId)g.jobIds.add(e.jobId);
  }
  return {groups:[...groups.values()].map(g=>({...g,elements:[...g.elements],additionalElements:[...g.additionalElements],jobIds:[...g.jobIds]})),
    dialogs:selected.filter(e=>e.kind==='dialog_shown').map(e=>({jobId:e.jobId,utc:e.utc,...e.data})),
    analysisBasis:'Heuristic suggestions from captured failure text; not a verified geometric root cause.'};
}

export async function warningReport(manager,{sessionId,jobId,afterSequence=0,limit=500}) {
  const captured=await manager.events(sessionId,afterSequence,limit);
  const snapshot=await readJson(path.join(manager.sessionDir(sessionId),'session.json'));
  const report={sessionId,jobId,...analyzeWarnings(captured.events,jobId),nextSequence:captured.nextSequence,
    historyMayBeTruncated:captured.historyMayBeTruncated,
    sessionSnapshot:{heartbeatUtc:snapshot.heartbeatUtc,currentJobId:snapshot.currentJobId,currentPhase:snapshot.currentPhase},
    policy:{managedTransactions:'rollback_on_warning_or_error',knownDialogFallback:'Dialog_Revit_DocWarnDialog → result 2, then explicit rollback of the same managed transaction group',
      supportedByBridge:snapshot.capabilities?.warningDiagnostics===true,
      dialogGroupRollback:snapshot.capabilities?.warningDialogGroupRollback===true},
    note:'Dialog records are history, not proof of current visibility. Existing model warnings: revit_warnings. Unknown/manual dialogs are not auto-accepted.'};
  if(jobId) {
    const job=await manager.job(sessionId,jobId);
    report.job={status:job.status,error:job.error,transactionStatus:job.timings?.transactionStatus,innerTransactionStatus:job.timings?.innerTransactionStatus,
      warningCount:job.timings?.warningCount,warnings:job.timings?.warnings};
  }
  return report;
}
