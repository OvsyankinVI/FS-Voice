import test from 'node:test';
import assert from 'node:assert/strict';
import {fitnessTools,rankPersonalFoods} from '../src/fitness-tools.js';
import {speak} from '../src/core.js';

const oldFetch=globalThis.fetch;
const oldUrl=process.env.SUPABASE_URL;
const oldKey=process.env.SUPABASE_SECRET_KEY;
function mock(rows, status=200, logs=[]) {
  process.env.SUPABASE_URL='https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY='test-only-key';
  globalThis.fetch=async (url,options)=>{
    assert.equal(new URL(url).pathname.startsWith('/rest/v1/'),true);
    assert.equal(options.headers['Accept-Profile'],'fitness');
    assert.equal(options.headers.apikey,'test-only-key');
    const path=new URL(url).pathname;
    const data=path.endsWith('/food_logs')?logs:rows;
    return {ok:status===200,status,json:async()=>data};
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

test('food logs take priority over stale daily summary',async()=>{
  mock([{day:'2026-10-28',kcal:'1',protein_g:'1',fat_g:'1',carbs_g:'1'}],200,[
    {kcal:'200',protein_g:'8',fat_g:'2',carbs_g:'40'},
    {kcal:'100',protein_g:'4',fat_g:'1',carbs_g:'20'}
  ]);
  const result=await fitnessTools.getTodayNutrition('2026-10-28');
  assert.deepEqual(result.consumed,{kcal:300,protein:12,fat:3,carbs:60});
});
test('missing macros in food logs are not treated as zero',async()=>{
  mock([],200,[{kcal:100,protein_g:null,fat_g:2,carbs_g:10}]);
  assert.equal((await fitnessTools.getTodayNutrition('2026-10-28')).status,'incomplete_day');
});

test('Russian inflections work across the catalog without fuzzy substitutions',()=>{
  const rows=['Кокосовое молоко','Шаурма Смоки Шаверме','Макароны Barilla варёные без масла','Протеин с фисташкой','Протеин с печеньем','Протеиновый батончик','Банан свежий (без кожуры)','Банановый соевый напиток для кофе'].map((name,id)=>({id,name}));
  const names=q=>rankPersonalFoods(rows,q).map(x=>x.name);
  assert.deepEqual(names('кокосового молока'),['Кокосовое молоко']);
  assert.deepEqual(names('шаурмы смоки шаверме'),['Шаурма Смоки Шаверме']);
  assert.deepEqual(names('протеина с фисташкой'),['Протеин с фисташкой']);
  assert.deepEqual(names('протеина с печеньем'),['Протеин с печеньем']);
  assert.deepEqual(names('протеин'),['Протеин с фисташкой','Протеин с печеньем']);
  assert.deepEqual(names('банан'),['Банан свежий (без кожуры)']);
  assert.deepEqual(names('кокосового батончика'),[]);
});
