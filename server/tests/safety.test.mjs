import {test} from 'node:test';
import assert from 'node:assert/strict';
import {references,mergeReferences} from '../safety.mjs';

test('preservation IDs are lossless, normalized and deduplicated',()=>{
  assert.deepEqual(references([{id:'0001',uniqueId:'u'},{id:'1',uniqueId:'u'},{id:'9223372036854775807',uniqueId:'v'}]),
    [{id:'1',uniqueId:'u'},{id:'9223372036854775807',uniqueId:'v'}]);
  assert.deepEqual(mergeReferences([{id:'1',uniqueId:'u'}],[{id:'2',uniqueId:'v'}]).map(x=>x.id),['1','2']);
});
test('preservation rejects conflicting, malformed or out-of-range identities',()=>{
  for(const id of ['0','-1','1.5','9223372036854775808'])assert.throws(()=>references([{id,uniqueId:'u'}]));
  assert.throws(()=>references([{id:'1',uniqueId:'u'},{id:'1',uniqueId:'changed'}]),/Conflicting/);
  assert.throws(()=>references(Array(20001).fill({id:'1',uniqueId:'u'})),/20000/);
});
