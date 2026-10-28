import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFoodBatch} from '../src/core.js';

test('Alice command: add 100 grams banana',()=>{
  assert.deepEqual(parseFoodBatch('добавь 100 граммов банана'),{status:'parsed',items:[{name:'банана',grams:100,meal:'перекус'}]});
});
test('Alice command: add 1 gram banana',()=>{
  assert.deepEqual(parseFoodBatch('добавь 1 грамм банана'),{status:'parsed',items:[{name:'банана',grams:1,meal:'перекус'}]});
});
test('Alice command: two foods',()=>{
  assert.deepEqual(parseFoodBatch('добавь 100 граммов банана и 40 граммов хлеба'),{status:'parsed',items:[{name:'банана',grams:100,meal:'перекус'},{name:'хлеба',grams:40,meal:'перекус'}]});
});
