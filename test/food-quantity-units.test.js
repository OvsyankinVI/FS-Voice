import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFoodQuantity,convertFoodQuantity,parseFoodBatch} from '../src/core.js';
test('normalizes supported units',()=>{
 assert.deepEqual(normalizeFoodQuantity('1,5','кг'),{amount:1500,unit:'g'});
 assert.deepEqual(normalizeFoodQuantity('0,5','л'),{amount:500,unit:'ml'});
 assert.deepEqual(normalizeFoodQuantity(3,'шт.'),{amount:3,unit:'pcs'});
 assert.deepEqual(normalizeFoodQuantity(2,'порции'),{amount:2,unit:'portion'});
});
test('refuses unsafe conversions',()=>{
 assert.equal(normalizeFoodQuantity(1.5,'шт'),null);
 assert.equal(convertFoodQuantity({amount:2,unit:'pcs'},{source_extra:{voice_unit:'g'}}),null);
 assert.equal(convertFoodQuantity({amount:200,unit:'ml'},{source_extra:{voice_unit:'g'}}),null);
 assert.equal(convertFoodQuantity({amount:2,unit:'pcs'},{source_extra:{voice_unit:'g',grams_per_piece:50}}).basisAmount,100);
});
test('batch retains explicit units',()=>{
 assert.equal(parseFoodBatch('добавь молоко 250 мл').items[0].unit,'ml');
 assert.equal(parseFoodBatch('добавь банан 150 г').items[0].unit,'g');
 assert.equal(parseFoodBatch('добавь кофе с банановым молоком 1 порция').items[0].unit,'portion');
 assert.equal(parseFoodBatch('добавь 2 сырника').items[0].grams,2);
});
