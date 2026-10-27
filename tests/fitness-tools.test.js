import test from 'node:test';
import assert from 'node:assert/strict';
import {fitnessTools} from '../src/fitness-tools.js';
import {speak} from '../src/core.js';

const oldFetch=globalThis.fetch;
const oldUrl=process.env.SUPABASE_URL;
const oldKey=process.env.SUPABASE_SECRET_KEY;
function mock(rows, status=200) {
  process.env.SUPABASE_URL='https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY='test-only-key';
  globalThis.fetch=async (url,options)=>{
    assert.equal(new URL(url).pathname.startsWith('/rest/v1/'),true);
    assert.equal(options.headers['Accept-Profile'],'fitness');
    assert.equal(options.headers.apikey,'test-only-key');
    return {ok:status===200,status,json:async()=>rows};
  };
}
test('Supabase nutrition matches existing speak contract',async()=>{
  mock([{day:'2026-10-27',kcal:'490',protein_g:'55',fat_g:'19',carbs_g:'30'}]);
  const result=await fitnessTools.getTodayNutrition('2026-10-27');
  assert.deepEqual(result,{status:'ok',date:'2026-10-27',consumed:{kcal:490,protein:55,fat:19,carbs:30}});
  assert.match(speak(result,{kcal:2370,protein:190,fat:70,carbs:245},'protein'),/Осталось 135/);
});
test('missing day is not zero',async()=>{
  mock([]);
  assert.equal((await fitnessTools.getTodayNutrition('2026-10-27')).status,'missing_day');
});
test('duplicate day does not silently choose one',async()=>{
  mock([{},{ }]);
  assert.equal((await fitnessTools.getTodayNutrition('2026-10-27')).status,'duplicate_day');
});
test('incomplete day is not zero',async()=>{
  mock([{kcal:null,protein_g:55,fat_g:19,carbs_g:30}]);
  assert.equal((await fitnessTools.getTodayNutrition('2026-10-27')).status,'incomplete_day');
});
test('HTTP failure is not silently swallowed',async()=>{
  mock([],403);
  await assert.rejects(fitnessTools.getTodayNutrition('2026-10-27'),/HTTP 403/);
});
test.after(()=>{globalThis.fetch=oldFetch;if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.SUPABASE_SECRET_KEY;else process.env.SUPABASE_SECRET_KEY=oldKey;});

test('Supabase nutrition targets read from private dashboard config',async()=>{
  mock([{config:{target:{kcal:[2370,2370],protein:[190,190],fat:[70,70],carbs:[245,245]}}}]);
  assert.deepEqual(await fitnessTools.getTargets(),{kcal:2370,protein:190,fat:70,carbs:245});
});
test('Supabase targets reject missing config',async()=>{
  mock([]);
  await assert.rejects(fitnessTools.getTargets(),/Expected exactly one/);
});
