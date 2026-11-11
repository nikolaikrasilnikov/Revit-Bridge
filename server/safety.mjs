export const preservationLimit=20000;
export function references(input=[]) {
  if(!Array.isArray(input)||input.length>preservationLimit)throw new Error('Expected at most 20000 preservation references');
  const found=new Map();
  for(const item of input) {
    if(!item||typeof item.id!=='string'||!/^\d{1,19}$/.test(item.id)||BigInt(item.id)<1n||BigInt(item.id)>9223372036854775807n||
      typeof item.uniqueId!=='string'||!item.uniqueId.trim()||item.uniqueId.length>128)throw new Error('Expected element id string and UniqueId');
    const id=BigInt(item.id).toString();
    if(found.has(id)&&found.get(id)!==item.uniqueId)throw new Error('Conflicting preservation identity');
    found.set(id,item.uniqueId);
  }
  return [...found].map(([id,uniqueId])=>({id,uniqueId}));
}
export function mergeReferences(before,created) { return references([...before,...created]); }
