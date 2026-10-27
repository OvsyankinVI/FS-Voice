import http from 'node:http';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {fitnessTools} from './fitness-tools.js';
import {GoogleAuth} from 'google-auth-library';
import {todayMoscow,nutritionForDay,targetsFromSettings,targetsFromSite,intent,speak,parseFoodCommand,parseFoodBatch} from './core.js';
const sheetId=process.env.SPREADSHEET_ID;
const siteUrl=process.env.TARGETS_JSON_URL || 'https://ovsyankinvi.github.io/FS/data.json';
const allowed=(process.env.ALLOWED_ALICE_USER_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
const webhookSecret=process.env.ALICE_WEBHOOK_SECRET||'';
function matchesSecret(candidate) {
  if(!webhookSecret || typeof candidate!=='string') return false;
  const expected=Buffer.from(webhookSecret), actual=Buffer.from(candidate);
  return expected.length===actual.length && timingSafeEqual(expected,actual);
}
function verifyWebhook(event) {
  const query=event?.queryStringParameters||{};
  const supplied=query.key||query.token||'';
  return matchesSecret(supplied);
}
function googleAuth() {
  const raw=process.env.GOOGLE_CREDENTIALS_JSON;
  const credentials=raw ? JSON.parse(raw) : undefined;
  return new GoogleAuth({credentials,scopes:['https://www.googleapis.com/auth/spreadsheets.readonly']});
}
async function getRows(range) {
  const client=await googleAuth().getClient();
  const token=await client.getAccessToken();
  const url=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`;
  const res=await fetch(url,{headers:{Authorization:`Bearer ${token.token}`},signal:AbortSignal.timeout(2500)});
  if(!res.ok) throw new Error(`Sheets API ${res.status}`);
  return (await res.json()).values||[];
}
async function loadTargets() {
  const settings=await getRows("'Настройки'!A1:B30");
  const exact=targetsFromSettings(settings);
  if(exact) return exact;
  const response=await fetch(siteUrl,{signal:AbortSignal.timeout(2000),cache:'no-store'});
  if(!response.ok) throw new Error('Targets unavailable');
  return targetsFromSite(await response.json());
}
function aliceResponse(req,text,endSession=false,state=null) {
  const answer={version:req.version||'1.0',session:req.session,response:{text,tts:text,end_session:endSession}};
  if(state)answer.session_state=state;
  return answer;
}

export async function handle(req) {
  const id=req?.session?.user?.user_id || req?.session?.user_id;
  if(!allowed.length || !id || !allowed.includes(id))
    return aliceResponse(req,'Доступ к этому дневнику не разрешён.',true);
  const phrase=req?.request?.original_utterance||'';
  if(req?.session?.new && !phrase.trim()) return aliceResponse(req,'Привет! Спроси про калории, белки или питание за сегодня.');
  try {
    const members=await fitnessTools.listFamilyMembers(id);
    const state=req?.state?.session||{};
    const recipientOf=(utterance)=>members.filter(m=>{
      const name=m.display_name.toLocaleLowerCase('ru').replace(/ё/g,'е');
      const stem=name.startsWith('ангелин')?'ангелин':name.startsWith('влад')?'влад':name;
      return utterance.toLocaleLowerCase('ru').replace(/ё/g,'е').includes(stem);
    });
    const resolveItems=async(ownerId,items)=>{
      const selected=[];
      for(const item of items){
        const name=item.name.replace(/^(?:владу|владиславу|ангелине|ангелину)\s+/i,'').replace(/\s+(?:владу|владиславу|ангелине|ангелину)$/i,'').trim();
        const personal=await fitnessTools.searchPersonalFoods(ownerId,name);
        const found=personal.length?personal:await fitnessTools.searchFoods(name);
        if(!found.length)return {error:'Не нашёл продукт «'+name+'». Ничего не записано.'};
        if(found.length>1)return {error:'Для «'+name+'» нашёл несколько вариантов: '+found.slice(0,3).map(x=>x.name).join(', ')+'. Уточни название. Ничего не записано.'};
        const f=found[0];
        selected.push({kind:f.kind,product_id:f.product_id,fdc_id:f.fdc_id,grams:item.grams,meal:({завтрак:'Завтрак',обед:'Обед',ужин:'Ужин',перекус:'Перекус'})[item.meal]||'Перекус',entry_key:randomUUID(),name:f.name});
      }
      return {selected};
    };
    const prepare=async(owner,items)=>{
      const result=await resolveItems(owner.owner_id,items);
      if(result.error)return aliceResponse(req,result.error);
      const summary=result.selected.map(x=>x.name+' '+x.grams+' граммов').join(', ');
      return aliceResponse(req,'Добавить для '+owner.display_name+': '+summary+'? Скажи да или нет.',false,{fs_batch_pending:{version:1,alice_user_id:id,owner_id:owner.owner_id,items:result.selected}});
    };
    const question=state.fs_batch_recipient;
    if(question?.version===1&&question.alice_user_id===id){
      if(/^(нет|отмена|отмени)$/i.test(phrase.trim()))return aliceResponse(req,'Отменил.');
      const chosen=recipientOf(phrase);
      if(chosen.length===1)return prepare(chosen[0],question.items);
      return aliceResponse(req,'Кому записать: '+members.map(m=>m.display_name).join(' или ')+'?',false,{fs_batch_recipient:question});
    }
    const pending=state.fs_batch_pending;
    if(pending?.version===1&&pending.alice_user_id===id){
      if(/^(нет|отмена|отмени)$/i.test(phrase.trim()))return aliceResponse(req,'Отменил.');
      if(/^(да|подтверждаю|верно)$/i.test(phrase.trim())){
        if(!members.some(m=>m.owner_id===pending.owner_id))return aliceResponse(req,'Дневник больше недоступен. Ничего не добавлено.');
        if(process.env.FS_VOICE_WRITE_ENABLED!=='true')return aliceResponse(req,'Запись на сервере пока выключена. Ничего не добавлено.');
        const items=pending.items;
        if(!Array.isArray(items)||items.length<1||items.length>10||items.some(x=>!['usda','personal'].includes(x.kind)||!Number.isFinite(Number(x.grams))||Number(x.grams)<=0||Number(x.grams)>10000||!/^[0-9a-f-]{36}$/i.test(String(x.entry_key))))return aliceResponse(req,'Ошибка подтверждения. Ничего не добавлено.');
        const ids=await fitnessTools.saveVoiceBatch({ownerId:pending.owner_id,items});
        return aliceResponse(req,Array.isArray(ids)&&ids.length===items.length?'Готово! Добавил '+ids.length+' продуктов в дневник.':'Не удалось подтвердить сохранение.');
      }
    }
    const command=parseFoodBatch(phrase);
    if(command){
      if(command.status!=='parsed')return aliceResponse(req,command.status==='too_many'?'За один раз можно добавить не больше десяти продуктов.':command.status==='missing_amount'?'Укажи массу каждого продукта в граммах.':'Проверь название и массу продуктов.');
      if(!members.length)return aliceResponse(req,'В FS нет доступных голосовых профилей.');
      const chosen=recipientOf(phrase);
      if(chosen.length>1)return aliceResponse(req,'Назови одного получателя.');
      if(chosen.length===1)return prepare(chosen[0],command.items);
      if(members.length===1)return prepare(members[0],command.items);
      return aliceResponse(req,'Кому записать: '+members.map(m=>m.display_name).join(' или ')+'?',false,{fs_batch_recipient:{version:1,alice_user_id:id,items:command.items}});
    }
    const day=todayMoscow();
    if(process.env.FITNESS_DATA_SOURCE==='supabase') {
      const nutrition=await fitnessTools.getTodayNutrition(day).catch(error=>{console.error('Supabase nutrition read failed:',error?.message||String(error));throw new Error('nutrition_read_failed');});
      const targets=await fitnessTools.getTargets().catch(error=>{console.error('Supabase targets read failed:',error?.message||String(error));throw new Error('targets_read_failed');});
      return aliceResponse(req,speak(nutrition,targets,intent(phrase)));
    }
    if(!sheetId) throw new Error('Missing SPREADSHEET_ID');
    const [days,targets]=await Promise.all([getRows("'Дни'!A1:F1000"),loadTargets()]);
    return aliceResponse(req,speak(nutritionForDay(days,day),targets,intent(phrase)));
  } catch(error) {
    console.error('Request failed:',error.message);
    return aliceResponse(req,'Сейчас не получается получить данные дневника. Попробуй позже.');
  }
}
const server=http.createServer(async (request,response)=>{
  const url=new URL(request.url,'http://localhost');
  if(request.method!=='POST'||url.pathname!=='/alice') {response.writeHead(404);return response.end();}
  if(!matchesSecret(url.searchParams.get('key'))) {response.writeHead(403);return response.end('Forbidden');}
  let raw='';
  for await(const chunk of request){raw+=chunk;if(raw.length>100000){response.writeHead(413);return response.end();}}
  try {
    const payload=JSON.parse(raw);
    const answer=await handle(payload);
    response.writeHead(200,{'content-type':'application/json; charset=utf-8'});
    response.end(JSON.stringify(answer));
  }catch(e){response.writeHead(400);response.end();}
});
if(process.env.RUN_HTTP_SERVER==='1') server.listen(Number(process.env.PORT||8080));
export async function handler(event) {
  if(!verifyWebhook(event)) return {statusCode:403,body:'Forbidden'};
  try {
    const rawBody=event.isBase64Encoded && typeof event.body==='string' ? Buffer.from(event.body,'base64').toString('utf8') : event.body;
    const payload=typeof rawBody==='string'?JSON.parse(rawBody):rawBody;
    if(!payload || typeof payload!=='object') throw new Error('Invalid payload');
    return {statusCode:200,headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify(await handle(payload))};
  } catch(error) {
    console.error('Invalid request:',error.message);
    return {statusCode:400,body:'Bad Request'};
  }
}
