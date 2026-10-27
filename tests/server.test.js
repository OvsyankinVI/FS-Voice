import test from 'node:test';
import assert from 'node:assert/strict';
import {handler} from '../src/server.js';

const oldSecret=process.env.ALICE_WEBHOOK_SECRET;
const oldUsers=process.env.ALLOWED_ALICE_USER_IDS;
// Environment must be set before importing server.js: this test only verifies
// the access rejection contract for malformed or unauthenticated requests.
test('rejects requests without webhook secret',async()=>{
  const result=await handler({body:'{}',queryStringParameters:{}});
  assert.equal(result.statusCode,403);
});
test('rejects requests with incorrect webhook secret',async()=>{
  const result=await handler({body:'{}',queryStringParameters:{key:'invalid-key'}});
  assert.equal(result.statusCode,403);
});
