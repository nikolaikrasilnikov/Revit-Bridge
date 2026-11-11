import {test} from 'node:test';
import assert from 'node:assert/strict';
import {warningAuthorization} from '../warning-policy.mjs';
const newBridge={capabilities:{authorizedWarningPolicy:true}};
test('default warning policy keeps rollback behavior, including old bridges',()=>{
 assert.deepEqual(warningAuthorization({},'transaction',{}),{});
 assert.deepEqual(warningAuthorization({warningPolicy:'rollback'},'query',{}),{});
});
test('explicit authorization is carried only on supported writing/preview jobs',()=>{
 const a={warningPolicy:'allow_warnings',warningApproval:'User explicitly approved all warnings for this transfer'};
 for(const mode of ['transaction','preview'])assert.deepEqual(warningAuthorization(a,mode,newBridge),a);
 for(const mode of ['query','none'])assert.throws(()=>warningAuthorization(a,mode,newBridge),/Read-only/);
 assert.throws(()=>warningAuthorization(a,'transaction',{}),/0.7.0/);
});
test('missing, empty, oversized or unknown authorizations fail before submission',()=>{
 for(const warningApproval of [undefined,'','  ','x'.repeat(2001)])assert.throws(()=>warningAuthorization({warningPolicy:'allow_warnings',warningApproval},'transaction',newBridge),/warningApproval/);
 assert.throws(()=>warningAuthorization({warningPolicy:'ignore_errors'},'transaction',newBridge),/Unknown/);
});
