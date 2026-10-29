import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFoodQuantity,convertFoodQuantity} from '../src/core.js';

test('unit normalization',()=>{
  assert.deepEqual(normalizeFoodQuantity('1,5','кг'),{amount:1500,unit:'g'});
  assert.deepEqual(normalizeFoodQuantity('0,5','литра'),{amount:500,unit:'ml'});
  assert.deepEqual(normalizeFoodQuantity('3','штуки'),{amount:3,unit:'pcs'});
  assert.deepEqual(normalizeFoodQuantity('2','порции'),{amount:2,unit:'portion'});
  assert.equal(normalizeFoodQuantity('1,5','штуки'),null);
});
test('conversion requires known product metadata',()=>{
  assert.equal(convertFoodQuantity({amount:3,unit:'pcs'},{source_extra:{voice_unit:'g',grams_per_piece:50}}).basisAmount,150);
  assert.equal(convertFoodQuantity({amount:3,unit:'pcs'},{source_extra:{voice_unit:'g'}}),null);
  assert.equal(convertFoodQuantity({amount:250,unit:'ml'},{source_extra:{voice_unit:'g'}}),null);
  assert.equal(convertFoodQuantity({amount:2,unit:'portion'},{source_extra:{voice_unit:'portion'}}).multiplier,2);
});
