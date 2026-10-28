// Private server-side Supabase read adapter. No dependency required.
// Never expose SUPABASE_SECRET_KEY to the browser, Alice payloads, or GitHub.
function credentials() {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!base || !key) throw new Error('Supabase is not configured');
  return {base, key};
}
async function select(schema, table, params = {}) {
  const {base, key} = credentials();
  const url = new URL('/rest/v1/' + table, base);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  // Opaque sb_secret_* keys belong in apikey, not in a Bearer JWT header.
  const headers = {apikey: key, 'Accept-Profile': schema, Accept: 'application/json'};
  if (!key.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + key;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(3500)
  });
  if (!res.ok) throw new Error('Supabase ' + schema + '.' + table + ' HTTP ' + res.status);
  return res.json();
}
async function rpc(schema,fn,payload) {
  const {base,key}=credentials();
  const headers={apikey:key,'Content-Profile':schema,'Accept-Profile':schema,'Content-Type':'application/json',Accept:'application/json'};
  if(!key.startsWith('sb_secret_'))headers.Authorization='Bearer '+key;
  const res=await fetch(new URL('/rest/v1/rpc/'+fn,base),{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(3500)});
  if(!res.ok){const body=await res.text();let detail='';try{const parsed=JSON.parse(body);detail=String(parsed.message||parsed.code||'').slice(0,180);}catch{}throw new Error('Supabase RPC '+fn+' HTTP '+res.status+(detail?' / '+detail:''));}
  if(res.status===204)return null;
  const body=await res.text();
  return body.trim()?JSON.parse(body):null;
}
export const fitnessTools = Object.freeze({

  stageConfirmation({aliceUserId,ownerId,items}) {return rpc('fitness','voice_stage_confirmation',{p_alice_user_id:aliceUserId,p_owner:ownerId,p_items:items});},
  confirmConfirmation(aliceUserId) {return rpc('fitness','voice_confirm_confirmation',{p_alice_user_id:aliceUserId});},
  cancelConfirmation(aliceUserId) {return rpc('fitness','voice_cancel_confirmation',{p_alice_user_id:aliceUserId});},
  saveVoiceBatch({ownerId,items}) {
    if(process.env.FS_VOICE_WRITE_ENABLED!=='true')throw new Error('Voice writes disabled');
    return rpc('fitness','voice_add_batch',{p_owner:ownerId,p_items:items});
  },
  async searchPersonalFoods(ownerId,query) {
    const q=String(query||'').trim().replace(/[%*,()]/g,' ');
    if(!ownerId||q.length<2)return [];
    const rows=await select('fitness','products',{select:'id,name,serving_basis',owner_id:'eq.'+ownerId,name:'ilike.*'+q+'*',limit:'8'});
    return rows.map(x=>({kind:'personal',product_id:x.id,name:x.name,detail:x.serving_basis}));
  },
  saveVoiceUsda({ownerId,fdcId,grams,meal,entryKey}) {
    if(process.env.FS_VOICE_WRITE_ENABLED!=='true')throw new Error('Voice writes disabled');
    return rpc('fitness','voice_add_usda',{p_owner:ownerId,p_fdc:fdcId,p_grams:grams,p_meal:meal,p_key:entryKey});
  },
  redeemAliceCode(code,aliceUserId) { return rpc('fitness','redeem_alice_link_code',{p_code:code,p_alice_user_id:aliceUserId}); },
  async listFamilyMembers(aliceUserId) {
    if(!aliceUserId)return [];
    const owners=(process.env.FS_VOICE_OWNER_IDS||'ce19fbb3-2e4e-4f15-b25e-6b0433d5cca2').split(',').map(v=>v.trim()).filter(v=>/^[0-9a-f-]{36}$/i.test(v));
    if(!owners.length)return [];
    return select('fitness','voice_profiles',{select:'owner_id,display_name',owner_id:'in.('+owners.join(',')+')',enabled:'eq.true',order:'display_name.asc',limit:'20'});
  },
  async resolveAliceOwner(aliceUserId) {
    if(!aliceUserId)return null;
    const rows=await select('fitness','alice_identity_links',{select:'owner_id',alice_user_id:'eq.'+String(aliceUserId),limit:'2'});
    return rows.length===1?rows[0].owner_id:null;
  },
  async searchFoods(query) {
    const q=String(query||'').trim().replace(/[%*,()]/g,' ');
    if(q.length<2)return [];
    const preferred=await select('fitness','preferred_foods',{select:'term_ru,usda_foods(fdc_id,name_en,name_ru,kcal_per_100g,protein_per_100g,fat_per_100g,carbs_per_100g)',term_ru:'ilike.*'+q+'*',limit:'10'});
    if(preferred.length===1 && preferred[0].usda_foods){const x=preferred[0].usda_foods;return [{kind:'usda',fdc_id:x.fdc_id,name:preferred[0].term_ru,detail:x.name_en}];}
    const [aliases,english]=await Promise.all([
      select('fitness','food_search_terms',{select:'term_ru,usda_foods(fdc_id,name_en,name_ru,kcal_per_100g,protein_per_100g,fat_per_100g,carbs_per_100g)',term_ru:'ilike.*'+q+'*',limit:'10'}),
      select('fitness','usda_foods',{select:'fdc_id,name_en,name_ru,kcal_per_100g,protein_per_100g,fat_per_100g,carbs_per_100g',name_en:'ilike.*'+q+'*',limit:'8'})
    ]);
    const result=[],seen=new Set();
    for(const row of aliases){const x=row.usda_foods;if(!x)continue;const key='u:'+x.fdc_id;if(seen.has(key))continue;seen.add(key);result.push({kind:'usda',fdc_id:x.fdc_id,name:row.term_ru,detail:x.name_en});}
    for(const x of english){const key='u:'+x.fdc_id;if(seen.has(key))continue;seen.add(key);result.push({kind:'usda',fdc_id:x.fdc_id,name:x.name_ru||x.name_en,detail:x.name_en});}
    return result.slice(0,10);
  },
  async getTargets() {
    const rows = await select('fitness', 'dashboard_config', {select: 'config', limit: '2'});
    if (rows.length !== 1) throw new Error('Expected exactly one dashboard configuration');
    const t = rows[0]?.config?.target;
    const keys = ['kcal','protein','fat','carbs'];
    if (!t || !keys.every(k => Number(Array.isArray(t[k]) ? t[k][0] : t[k]) > 0)) throw new Error('Invalid nutrition targets');
    return Object.fromEntries(keys.map(k => [k, Number(Array.isArray(t[k]) ? t[k][0] : t[k])]));
  },
  async getTodayNutrition(day) {
    const ownerId=(process.env.FS_VOICE_OWNER_IDS||'ce19fbb3-2e4e-4f15-b25e-6b0433d5cca2').split(',')[0].trim();
    const rows=await select('fitness','food_logs',{owner_id:'eq.'+ownerId,day:'eq.'+day,select:'kcal,protein_g,fat_g,carbs_g',limit:'1000'});
    const fields=['kcal','protein_g','fat_g','carbs_g'];
    if(rows.length){
      if(rows.some(row=>fields.some(k=>row[k]===null||row[k]===undefined||!Number.isFinite(Number(row[k])))))
        return {status:'incomplete_day',date:day};
      const sum=Object.fromEntries(fields.map(k=>[k,rows.reduce((total,row)=>total+Number(row[k]),0)]));
      return {status:'ok',date:day,consumed:{kcal:sum.kcal,protein:sum.protein_g,fat:sum.fat_g,carbs:sum.carbs_g}};
    }
    const summaries=await select('fitness','daily_summaries',{owner_id:'eq.'+ownerId,day:'eq.'+day,select:'day,kcal,protein_g,fat_g,carbs_g',limit:'2'});
    if(!summaries.length)return {status:'missing_day',date:day};
    if(summaries.length>1)return {status:'duplicate_day',date:day};
    const row=summaries[0];
    if(fields.some(k=>row[k]===null||row[k]===undefined||!Number.isFinite(Number(row[k]))))return {status:'incomplete_day',date:day};
    return {status:'ok',date:day,consumed:{kcal:Number(row.kcal),protein:Number(row.protein_g),fat:Number(row.fat_g),carbs:Number(row.carbs_g)}};
  },
  getNutritionByDate(day) { return this.getTodayNutrition(day); },
  getRecentWorkouts(limit = 30) {
    return select('fitness', 'workout_sets', {select: 'day,exercise,weight_kg,reps,rir,workout_group,set_number', order: 'day.desc,source_row.desc', limit: Math.min(Math.max(1, limit), 100)});
  },
  getExerciseHistory(exercise, limit = 30) {
    if (typeof exercise !== 'string' || !exercise.trim()) throw new Error('Exercise name required');
    // Filter is passed as a URL query value, never interpolated into SQL.
    return select('fitness', 'workout_sets', {select: 'day,exercise,weight_kg,reps,rir,workout_group,set_number', exercise: 'ilike.*' + exercise.replace(/[*,()]/g, '') + '*', order: 'day.desc,source_row.desc', limit: Math.min(Math.max(1, limit), 100)});
  }
});
