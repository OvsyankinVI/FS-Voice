import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWithGemini,validateAiFoodCommand} from '../src/ai-parser.js';

test('accepts valid structured food command',()=>{
  assert.deepEqual(validateAiFoodCommand({intent:'add_food',meal:'Завтрак',items:[{name:'сырник',quantity:2,unit:'pcs'}]}),{intent:'add_food',meal:'Завтрак',items:[{name:'сырник',quantity:2,unit:'pcs'}]});
});
test('rejects missing quantity and fractional pieces',()=>{
  assert.equal(validateAiFoodCommand({intent:'add_food',items:[{name:'сырник',unit:'pcs'}]}),null);
  assert.equal(validateAiFoodCommand({intent:'add_food',items:[{name:'сырник',quantity:1.5,unit:'pcs'}]}),null);
});
test('disabled by default, makes no requests',async()=>{
  const old=process.env.AI_ENABLED;delete process.env.AI_ENABLED;
  try{assert.deepEqual(await parseWithGemini('добавь 2 сырника',{apiKey:'test',fetchImpl:()=>{throw Error('must not call')}}),{status:'disabled'})}
  finally{if(old===undefined)delete process.env.AI_ENABLED;else process.env.AI_ENABLED=old}
});
test('mock response parsed without saving anything',async()=>{
  const old=process.env.AI_ENABLED;process.env.AI_ENABLED='true';
  try{
    const result=await parseWithGemini('добавь 2 сырника',{apiKey:'test',fetchImpl:async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify({intent:'add_food',meal:'Завтрак',items:[{name:'сырник',quantity:2,unit:'pcs'}]})}]}}]})})});
    assert.equal(result.status,'parsed');assert.equal(result.command.items[0].quantity,2);
  }finally{if(old===undefined)delete process.env.AI_ENABLED;else process.env.AI_ENABLED=old}
});
