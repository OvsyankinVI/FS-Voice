import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ALICE_WEBHOOK_SECRET='unit-test-webhook-key';
process.env.ALLOWED_ALICE_USER_IDS='test-user';
const {handler}=await import('../src/server.js');
const payload={version:'1.0',session:{new:true,user:{user_id:'test-user'}},request:{original_utterance:''}};
const base={queryStringParameters:{key:'unit-test-webhook-key'}};

test('rejects missing and incorrect webhook keys',async()=>{
  assert.equal((await handler({body:'{}',queryStringParameters:{}})).statusCode,403);
  assert.equal((await handler({body:'{}',queryStringParameters:{key:'wrong'}})).statusCode,403);
});
test('accepts plain JSON HTTP body',async()=>{
  const result=await handler({...base,body:JSON.stringify(payload)});
  assert.equal(result.statusCode,200);
  assert.match(JSON.parse(result.body).response.text,/Привет/);
});
test('accepts base64-encoded JSON HTTP body',async()=>{
  const result=await handler({...base,isBase64Encoded:true,body:Buffer.from(JSON.stringify(payload)).toString('base64')});
  assert.equal(result.statusCode,200);
  assert.match(JSON.parse(result.body).response.text,/Привет/);
});
test('rejects malformed authorized body',async()=>{
  assert.equal((await handler({...base,body:'{broken'})).statusCode,400);
});

test('food command returns valid Alice response rather than HTTP failure',async()=>{
  const req={version:'1.0',session:{new:false,user:{user_id:'test-user'},message_id:4,session_id:'test-session'},request:{original_utterance:'добавь 100 грамм банана',command:'добавь 100 грамм банана'}};
  const result=await handler({...base,body:JSON.stringify(req)});
  assert.equal(result.statusCode,200);
  const body=JSON.parse(result.body);
  assert.equal(body.version,'1.0');
  assert.equal(typeof body.response?.text,'string');
  assert.ok(body.response.text.length>0);
  assert.doesNotMatch(body.response.text,/Внутренняя ошибка Джарвиса/);
});

test('real Yandex Dialogs request reaches food lookup with mocked Supabase',async()=>{
  const previous={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SECRET_KEY,fetch:globalThis.fetch};
  process.env.SUPABASE_URL='https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY='sb_secret_test';
  const calls=[];
  globalThis.fetch=async(input)=>{
    const url=new URL(String(input));calls.push(url.pathname);
    if(url.pathname.endsWith('/voice_profiles'))return new Response(JSON.stringify([{owner_id:'ce19fbb3-2e4e-4f15-b25e-6b0433d5cca2',display_name:'Влад'}]),{status:200,headers:{'Content-Type':'application/json'}});
    if(url.pathname.endsWith('/products'))return new Response('[]',{status:200,headers:{'Content-Type':'application/json'}});
    if(url.pathname.endsWith('/preferred_foods'))return new Response('[]',{status:200,headers:{'Content-Type':'application/json'}});
    if(url.pathname.endsWith('/food_search_terms'))return new Response(JSON.stringify([{term_ru:'банан',usda_foods:{fdc_id:173944,name_en:'Bananas, raw',name_ru:'Банан'}}]),{status:200,headers:{'Content-Type':'application/json'}});
    if(url.pathname.endsWith('/usda_foods'))return new Response('[]',{status:200,headers:{'Content-Type':'application/json'}});
    if(url.pathname.endsWith('/rpc/voice_stage_confirmation'))return new Response(null,{status:204});
    throw Error('Unexpected mock request '+url.pathname);
  };
  try {
    const request={meta:{locale:'ru-RU',timezone:'UTC',interfaces:{screen:{},payments:{},account_linking:{}}},session:{message_id:8,session_id:'ab4526b2-ae45-41ab-bf95-a7932c9ce875',skill_id:'4dc9c14f-fd67-43a3-8c71-18eedebc16c3',user:{user_id:'test-user'},application:{application_id:'app'},user_id:'app',new:false},request:{command:'добавь 100 грамм банана',original_utterance:'добавь 100 грамм банана',nlu:{tokens:['добавь','100','грамм','банана'],entities:[{type:'YANDEX.NUMBER',tokens:{start:1,end:2},value:100}],intents:{}},markup:{dangerous_context:false},type:'SimpleUtterance'},version:'1.0'};
    const result=await handler({...base,body:JSON.stringify(request)});
    assert.equal(result.statusCode,200);
    const answer=JSON.parse(result.body);
    assert.match(answer.response.text,/Добавить для Влад/);
    assert.equal(answer.session_state.fs_batch_pending.items[0].grams,100);
    assert.ok(calls.includes('/rest/v1/voice_profiles'));
  } finally {
    globalThis.fetch=previous.fetch;
    if(previous.url===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previous.url;
    if(previous.key===undefined)delete process.env.SUPABASE_SECRET_KEY;else process.env.SUPABASE_SECRET_KEY=previous.key;
  }
});

test('Alice durable two-turn confirmation without state saves once and can save again',async()=>{
 const old={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SECRET_KEY,write:process.env.FS_VOICE_WRITE_ENABLED,fetch:globalThis.fetch};
 process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SECRET_KEY='sb_secret_test';process.env.FS_VOICE_WRITE_ENABLED='true';
 let saved=0,staged=null;
 globalThis.fetch=async(input,opts={})=>{
  const path=new URL(String(input)).pathname;
  const json=(data)=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  if(path.endsWith('/voice_profiles'))return json([{owner_id:'ce19fbb3-2e4e-4f15-b25e-6b0433d5cca2',display_name:'Влад'}]);
  if(path.endsWith('/products'))return json([{id:'4f5f6ac7-a6da-44a3-85cd-8160951a2b54',name:'Harry’s American Sandwich хлеб',serving_basis:'100 г'}]);
  if(path.endsWith('/rpc/voice_stage_confirmation')){staged=JSON.parse(opts.body);return new Response(null,{status:204});}
  if(path.endsWith('/rpc/voice_confirm_confirmation')){
   if(!staged)return json({status:'missing'});
   const items=staged.p_items;staged=null;assert.equal(items.length,1);assert.equal(items[0].grams,40);saved++;return json({status:'saved',count:1});
  }
  if(path.endsWith('/rpc/voice_cancel_confirmation')){staged=null;return json(true);}
  if(path.endsWith('/rpc/voice_add_batch')){
   const body=JSON.parse(opts.body);assert.equal(body.p_items.length,1);assert.equal(body.p_items[0].grams,40);
   saved++;return json(['11111111-1111-4111-8111-111111111111']);
  }
  throw Error('Unexpected request '+path);
 };
 const request=(command,state)=>({version:'1.0',session:{new:false,user:{user_id:'test-user'},message_id:1,session_id:'test-session'},request:{original_utterance:command,command},...(state?{state}: {})});
 const send=async(req)=>JSON.parse((await handler({...base,body:JSON.stringify(req)})).body);
 try{
  const first=await send(request('добавь 40 грамм хлеб'));
  assert.match(first.response.text,/Добавить для Влад/);
  assert.ok(first.session_state.fs_batch_pending);
  assert.ok(first.user_state_update.fs_batch_pending);
  assert.equal(saved,0);
  const confirm=await send(request('да'));
  assert.match(confirm.response.text,/Готово/);
  assert.equal(saved,1);
  const second=await send(request('добавь 40 грамм хлеб'));
  const confirm2=await send(request('да'));
  assert.match(confirm2.response.text,/Готово/);
  assert.equal(saved,2);
  const orphan=await send(request('да'));
  assert.match(orphan.response.text,/Нет ожидающей записи/);
  assert.equal(saved,2);
 }finally{
  globalThis.fetch=old.fetch;
  for(const [name,value] of [['SUPABASE_URL',old.url],['SUPABASE_SECRET_KEY',old.key],['FS_VOICE_WRITE_ENABLED',old.write]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}
 }
});
