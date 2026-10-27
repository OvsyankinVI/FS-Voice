import http from 'node:http';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {fitnessTools} from './fitness-tools.js';
import {GoogleAuth} from 'google-auth-library';
import {todayMoscow,nutritionForDay,targetsFromSettings,targetsFromSite,intent,speak,parseFoodCommand} from './core.js';
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
    const link=phrase.trim().toUpperCase().match(/^(?:ПРИВЯЖИ|ПОДКЛЮЧИ|СВЯЖИ)(?:\\s+(?:АККАУНТ|FS|ДНЕВНИК))?\\s+([0-9]{3})$/i);
    if(link){const ok=await fitnessTools.redeemAliceCode(link[1],id);return aliceResponse(req,ok?'Дневник FS успешно привязан.':'Код неверен или истёк. Создай новый код на сайте FS.');}
    const pending=req?.state?.session?.fs_pending;
    if(pending && pending.alice_user_id===id && pending.version===1){
      if(/^(нет|отмена|отмени)$/i.test(phrase.trim()))return aliceResponse(req,'Хорошо, отменил.');
      if(/^(да|подтверждаю|верно)$/i.test(phrase.trim()))return aliceResponse(req,'Подтверждение принято. Сохранение в дневник пока отключено до завершения привязки и проверки прав.');
    }
    const foodCommand=parseFoodCommand(phrase);if(foodCommand){if(foodCommand.status==='missing_amount')return aliceResponse(req,'Скажи название продукта и количество в граммах.');if(foodCommand.status==='invalid_amount')return aliceResponse(req,'Укажи массу продукта от одного до десяти тысяч граммов.');if(foodCommand.status==='missing_product')return aliceResponse(req,'Не расслышал название продукта. Повтори, пожалуйста.');const members=await fitnessTools.listFamilyMembers(id);if(!members.length)return aliceResponse(req,'Сначала привяжи семейные дневники FS. Пока ничего не записано.');const lower=phrase.toLocaleLowerCase('ru');const recipients=members.filter(m=>{const name=m.display_name.toLocaleLowerCase('ru');const stem=name.startsWith('ангелин')?'ангелин':name.startsWith('влад')?'влад':name;return lower.includes(stem);});if(recipients.length!==1 && !(members.length===1 && recipients.length===0))return aliceResponse(req,recipients.length?'Уточни одного получателя: '+members.map(m=>m.display_name).join(' или ')+'.':'Кому записать: '+members.map(m=>m.display_name).join(' или ')+'? Пока ничего не записано.');const matches=await fitnessTools.searchFoods(foodCommand.name);if(!matches.length)return aliceResponse(req,'Не нашёл продукт «'+foodCommand.name+'» в каталоге. Попробуй уточнить название.');if(matches.length>1)return aliceResponse(req,'Нашёл несколько вариантов: '+matches.slice(0,3).map((x,i)=>(i+1)+': '+x.name+(x.detail?' — '+x.detail:'')).join('; ')+'. Уточни продукт. Запись пока не создана.');return aliceResponse(req,'Для '+recipients[0].display_name+' нашёл '+matches[0].name+', '+foodCommand.grams+' граммов'+(foodCommand.meal?', '+foodCommand.meal:'')+'. Подтверди выбор словом да или отмени. Пока запись не создаётся.',false,{fs_pending:{version:1,alice_user_id:id,entry_key:randomUUID(),fdc_id:matches[0].fdc_id,grams:foodCommand.grams,meal:foodCommand.meal||'перекус'}})}const day=todayMoscow();
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
