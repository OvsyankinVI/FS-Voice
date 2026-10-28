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
