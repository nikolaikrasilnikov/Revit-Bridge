import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeWarnings,warningAdvice} from '../warnings.mjs';

test('warning report preserves IDs, scopes by job and avoids two-stage double counting',()=>{
  const d={documentId:'doc',failureId:'overlap-guid',severity:'Warning',description:'Стены перекрываются',elements:['11','12'],additionalElements:['13'],automaticAction:'rollback_transaction'};
  const events=[{kind:'transaction_failure',jobId:'a',data:d},{kind:'failure',jobId:'a',data:d},
    {kind:'failure',jobId:'b',data:{...d,elements:['21']}},
    {kind:'dialog_shown',jobId:'a',data:{dialogId:'Dialog_Revit_DocWarnDialog',automaticResponse:true,resultCode:2}}];
  const a=analyzeWarnings(events,'a');assert.equal(a.groups.length,1);assert.equal(a.groups[0].occurrences,1);
  assert.deepEqual(a.groups[0].elements,['11','12']);assert.deepEqual(a.groups[0].additionalElements,['13']);
  assert.equal(a.groups[0].category,'overlap_or_duplicate');assert.equal(a.dialogs[0].resultCode,2);
  assert.equal(analyzeWarnings(events).groups[0].occurrences,2);
});

test('unknown warnings remain unclassified and do not propose blind deletion',()=>{
  assert.equal(warningAdvice('Unknown native failure').category,'unclassified');
  assert.equal(warningAdvice('Room is not enclosed').category,'spatial_boundary');
  assert.equal(warningAdvice('Constraints are not satisfied').category,'constraint');
  assert.deepEqual(analyzeWarnings([]).groups,[]);
});
