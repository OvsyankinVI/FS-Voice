import http from 'node:http';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {fitnessTools} from './fitness-tools.js';

import {todayMoscow,nutritionForDay,targetsFromSettings,targetsFromSite,intent,speak,parseFoodCommand,parseFoodBatch} from './core.js';
const sheetId=process.env.SPREADSHEET_ID;
const siteUrl=process.env.TARGETS_JSON_URL || 'https://ovsyankinvi.github.io/FS/data.json';
const allowed=(process.env.ALLOWED_ALICE_USER_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
const webhookSecret=process.env.ALICE_WEBHOOK_SECRET||'';
const BUILD='0.4.2-count-correction-20261029';
function diagnostic(stage,error){
  const message=String(error?.message||error||'unknown').replace(/(sb_secret_[a-zA-Z0-9_-]+|Bearer\s+\S+)/g,'[REDACTED]');
  console.error('[FS-Voice]',BUILD,stage,error?.name||'Error',message);
}
function safeErrorCode(error){
  const type=['TypeError','ReferenceError','RangeError','SyntaxError','AggregateError'].includes(error?.name)?error.name:'Error';
  const message=String(error?.message||'');
  const category=/Supabase is not configured/i.test(message)?'SUPABASE_CONFIG':/Supabase.*HTTP\s*(\d+)/i.test(message)?'SUPABASE_HTTP_'+message.match(/Supabase.*HTTP\s*(\d+)/i)[1]:/timeout|abort/i.test(message)?'TIMEOUT':/fetch failed/i.test(message)?'NETWORK':'UNCLASSIFIED';
  return type+' / '+category;
}


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
async function googleAuth() {
  const {GoogleAuth}=await import('google-auth-library');
  const raw=process.env.GOOGLE_CREDENTIALS_JSON;
  const credentials=raw ? JSON.parse(raw) : undefined;
  return new GoogleAuth({credentials,scopes:['https://www.googleapis.com/auth/spreadsheets.readonly']});
}
async function getRows(range) {
  const client=await (await googleAuth()).getClient();
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
  if(state){answer.session_state=state;answer.user_state_update=state;}
  return answer;
}

export async function handle(req) {
  const id=req?.session?.user?.user_id || req?.session?.user_id;
  if(!allowed.length || !id || !allowed.includes(id))
    return aliceResponse(req,'Доступ к этому дневнику не разрешён.',true);
  const phrase=req?.request?.original_utterance||'';
  // Diagnostic command: independent of Supabase and nutrition availability.
  if (/^(?:джарвис[,.!]?\s*)?(?:какая\s+у\s+тебя\s+версия|назови\s+(?:свою\s+)?версию|версия)(?:[?!.\s]*)$/iu.test(phrase.trim()))
    return aliceResponse(req,'Версия Джарвиса: '+BUILD+'.');
  if(req?.session?.new && !phrase.trim()) return aliceResponse(req,'Привет! Спроси про калории, белки или питание за сегодня.');
  let stage='parse_command';
  try {
    const parsedCommand=parseFoodBatch(phrase);
    console.info('[FS-Voice]',BUILD,'command',parsedCommand?'food':'read');
    stage='load_family';
    const members=await fitnessTools.listFamilyMembers(id);
    stage='route_command';
    const state=req?.state?.session?.fs_edit_pending||req?.state?.session?.fs_batch_pending||req?.state?.session?.fs_batch_recipient ? req.state.session : (req?.state?.user||req?.state?.session||{});
    console.info('[FS-Voice]',BUILD,'confirmation_state',state.fs_batch_pending?'pending':state.fs_batch_recipient?'recipient':'none');
    const recipientOf=(utterance)=>members.filter(m=>{
      const name=m.display_name.toLocaleLowerCase('ru').replace(/ё/g,'е');
      const stem=name.startsWith('ангелин')?'ангелин':name.startsWith('влад')?'влад':name;
      return utterance.toLocaleLowerCase('ru').replace(/ё/g,'е').includes(stem);
    });
    const resolveItems=async(ownerId,items)=>{
      const selected=[];
      for(const item of items){
        const name=item.name.replace(/^(?:владу|владиславу|ангелине|ангелину)\s+/i,'').replace(/\s+(?:владу|владиславу|ангелине|ангелину)$/i,'').trim();
        console.info('[FS-Voice]',BUILD,'search_product',name.length);
        stage='search_personal';
        let personal=await fitnessTools.searchPersonalFoods(ownerId,name);
        // Prefer the plain banana over banana-flavoured drinks.
        if(name.toLocaleLowerCase('ru').replace(/ё/g,'е')==='банан'){
          const fruit=personal.filter(x=>/^банан свежий/i.test(x.name));
          if(fruit.length===1)personal=fruit;
        }
        stage='search_usda';
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
      stage='stage_confirmation';
      await fitnessTools.stageConfirmation({aliceUserId:id,ownerId:owner.owner_id,items:result.selected.map(({name,...item})=>item)});
      const summary=result.selected.map(x=>x.name+' '+x.grams+(x.name==='Сырник домашний'?' шт.':x.name==='Завтрак с бутербродом'?' порция':' граммов')).join(', ');
      return aliceResponse(req,'Добавить для '+owner.display_name+': '+summary+'? Скажи да или нет.',false,{fs_batch_pending:{version:1,alice_user_id:id,owner_id:owner.owner_id,items:result.selected}});
    };
    // Correction of a previously logged count-based serving, not a new food entry.
    const countCorrection=phrase.trim().toLocaleLowerCase('ru').replace(/ё/g,'е').match(/^(?:я\\s+)?(?:съел|съела|ел|ела)\\s+не\\s+(\\d{1,3})\\s+сырник(?:а|ов|и)?,?\\s+а\\s+(\\d{1,3})(?:\\s+сырник(?:а|ов|и)?)?[.!?]*$/u);
    if(countCorrection){
      const previous=Number(countCorrection[1]),grams=Number(countCorrection[2]);
      if(previous<1||grams<1||grams>100)return aliceResponse(req,'Укажи количество сырников от 1 до 100.');
      if(members.length!==1)return aliceResponse(req,'Уточни, чей дневник исправить.');
      const owner=members[0];
      stage='find_syrniki';
      const rows=await fitnessTools.listTodayFoodLogs(owner.owner_id,todayMoscow());
      const found=rows.filter(row=>String(row.display_name||'').toLocaleLowerCase('ru').includes('сырник')&&Number(row.source_extra?.grams)===previous);
      if(found.length!==1)return aliceResponse(req,found.length?'Нашёл несколько записей с '+previous+' сырниками. Уточни запись, ничего не изменено.':'Не нашёл запись с '+previous+' сырниками за сегодня. Ничего не изменено.');
      return aliceResponse(req,'Исправить для '+owner.display_name+': было '+previous+' сырника, фактически '+grams+'? Скажи да или нет.',false,{fs_edit_pending:{version:1,alice_user_id:id,owner_id:owner.owner_id,log_id:found[0].id,action:'update',grams}});
    }
    // Natural correction of a previously logged piece count, not a new meal.
    const eatenCorrection=phrase.trim().toLocaleLowerCase('ru').replace(/ё/g,'е').match(/^(?:я\\s+)?(?:съел|съела|поел|поела)\\s+не\\s+(\\d{1,3})\\s+сырник(?:а|ов)?,?\\s+а\\s+(\\d{1,3})(?:\\s+сырник(?:а|ов)?)?[.!?\\s]*$/iu);
    const correctionOld=eatenCorrection?Number(eatenCorrection[1]):null;
    const correctionNew=eatenCorrection?Number(eatenCorrection[2]):null;
    if(eatenCorrection&&(correctionOld<1||correctionNew<1||correctionOld>100||correctionNew>100))return aliceResponse(req,'Укажи количество сырников от одного до ста.');
    const correctionPhrase=eatenCorrection?'измени сырник домашний с '+correctionOld+' на '+correctionNew:phrase.trim();
    const editMatch=correctionPhrase.match(/^(?:(?:джарвис|пожалуйста)[, ]+)?(измени(?:ть)?|поменяй|исправь|удали(?:ть)?|убери)\s+(?:(?:вес|массу)\s+)?(.+?)\s*$/iu);
    if(editMatch){
      const action=/^(удал|убер)/iu.test(editMatch[1])?'delete':'update';
      let rest=editMatch[2].replace(/\s+из\s+(?:сегодняшнего\s+)?дневника.*$/iu,'').trim();
      const mass=rest.match(/\s+(?:со?\s+\d+(?:[.,]\d+)?\s*(?:(?:грамм(?:ов|а)?|г)\s*)?)?(?:на|до)\s+(\d+(?:[.,]\d+)?)\s*(?:грамм(?:ов|а)?|г)?$/iu);
      const grams=mass?Number(mass[1].replace(',','.')):null;
      if(action==='update'&&(!Number.isFinite(grams)||grams<=0||grams>10000))return aliceResponse(req,'Назови новую массу, например: измени вес банана со 100 на 150 граммов.');
      if(mass)rest=rest.slice(0,mass.index).trim();
      const oldMass=rest.match(/\s+со?\s+(\d+(?:[.,]\d+)?)\s*(?:грамм(?:ов|а)?|г)?$/iu);
      const previous=eatenCorrection?correctionOld:oldMass?Number(oldMass[1].replace(',','.')):null;
      if(oldMass)rest=rest.slice(0,oldMass.index).trim();
      const meal=rest.match(/\s+(?:на\s+)?(завтрак|обед|ужин|перекус)(?:е|а)?$/iu);
      if(meal)rest=rest.slice(0,meal.index).trim();
      rest=rest.replace(/^(?:продукт|запись)\s+/iu,'').trim();
      if(!rest||!members.length)return aliceResponse(req,'Уточни название продукта и получателя.');
      const chosen=recipientOf(phrase);
      const owner=chosen.length===1?chosen[0]:members.length===1?members[0]:null;
      if(!owner)return aliceResponse(req,'Уточни, чей дневник изменить: '+members.map(x=>x.display_name).join(' или ')+'.');
      stage='find_food_entry';
      const rows=await fitnessTools.listTodayFoodLogs(owner.owner_id,todayMoscow());
      const norm=x=>String(x||'').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^a-zа-я0-9]+/gi,' ').trim();
      const stem=x=>norm(x).split(' ').filter(Boolean).map(w=>w.slice(0,Math.max(4,w.length-2)));
      const words=stem(rest);
      const found=rows.filter(row=>{
        const name=norm(row.display_name||row.original_text);
        const matches=words.every(w=>name.includes(w));
        const weight=Number(row.source_extra?.grams);
        return matches&&(previous===null||weight===previous)&&(!meal||norm(row.meal_type).includes(norm(meal[1]).slice(0,4)));
      });
      if(!found.length)return aliceResponse(req,'Не нашёл подходящую запись за сегодня. Ничего не изменено.');
      if(found.length>1)return aliceResponse(req,'Нашёл '+found.length+' похожих записей: '+found.slice(0,4).map((x,i)=>(i+1)+': '+x.display_name+', '+(x.source_extra?.grams||'масса неизвестна')+' граммов, '+(x.meal_type||'приём пищи не указан')).join('; ')+'. Уточни массу или приём пищи. Ничего не изменено.');
      const row=found[0];
      const pieceUnit=/^сырник домашний$/iu.test(row.display_name||'');
      return aliceResponse(req,(action==='delete'?'Удалить':'Изменить')+' для '+owner.display_name+': '+row.display_name+', '+(row.source_extra?.grams||'масса неизвестна')+(pieceUnit?' штуки':' граммов')+(action==='update'?' на '+grams+(pieceUnit?' штуки':' граммов'):'')+'? Скажи да или нет.',false,{fs_edit_pending:{version:1,alice_user_id:id,owner_id:owner.owner_id,log_id:row.id,action,grams}});
    }
    const editPending=state.fs_edit_pending;
    if(editPending?.version===1&&editPending.alice_user_id===id){
      if(/^(нет|отмена|отмени)$/iu.test(phrase.trim()))return aliceResponse(req,'Отменил изменение.');
      if(/^(да|подтверждаю|верно)$/iu.test(phrase.trim())){
        if(!members.some(m=>m.owner_id===editPending.owner_id))return aliceResponse(req,'Дневник больше недоступен.');
        stage='edit_food';
        const result=await fitnessTools.editTodayFood({aliceUserId:id,ownerId:editPending.owner_id,logId:editPending.log_id,action:editPending.action,grams:editPending.grams});
        return aliceResponse(req,result?.status==='ok'?'Готово! '+(editPending.action==='delete'?'Удалил продукт из дневника.':'Изменил массу продукта в дневнике.'):'Не удалось изменить запись: '+(result?.status||'не найдена')+'.');
      }
    }
    if(/^(да|подтверждаю|верно)$/i.test(phrase.trim())){
      if(process.env.FS_VOICE_WRITE_ENABLED!=='true')return aliceResponse(req,'Запись на сервере пока выключена. Ничего не добавлено.');
      stage='confirm_confirmation';
      const result=await fitnessTools.confirmConfirmation(id);
      if(result?.status==='saved'){const count=Number(result.count)||0;const label=count===1?'продукт':count>=2&&count<=4?'продукта':'продуктов';return aliceResponse(req,'Готово! Добавил '+count+' '+label+' в дневник.');}
      if(result?.status==='expired')return aliceResponse(req,'Подтверждение устарело. Назови продукт и массу ещё раз.');
      return aliceResponse(req,'Нет ожидающей записи для подтверждения. Назови продукт и массу ещё раз.');
    }
    if(/^(нет|отмена|отмени)$/i.test(phrase.trim())){
      stage='cancel_confirmation';
      const cancelled=await fitnessTools.cancelConfirmation(id);
      return aliceResponse(req,cancelled?'Отменил запись.':'Нет ожидающей записи для отмены.');
    }
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
        stage='save_batch';
        const ids=await fitnessTools.saveVoiceBatch({ownerId:pending.owner_id,items});
        return aliceResponse(req,Array.isArray(ids)&&ids.length===items.length?'Готово! Добавил '+ids.length+' продуктов в дневник.':'Не удалось подтвердить сохранение.');
      }
    }
    if(/^(да|подтверждаю|верно)$/i.test(phrase.trim()))return aliceResponse(req,'Нет ожидающей записи для подтверждения. Назови продукт и массу ещё раз.');
    const command=parsedCommand;
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
    diagnostic(stage,error);
    if(stage==='confirm_confirmation'||stage==='save_batch'){const detail=String(error?.message||'').replace(/(sb_secret_[a-zA-Z0-9_-]+|Bearer\\s+\\S+)/g,'[REDACTED]').slice(0,220);return aliceResponse(req,'Ошибка записи, этап '+stage+'. База отклонила операцию, запись не подтверждена. Диагностика: '+detail+'.');}
    return aliceResponse(req,'Ошибка Джарвиса. Этап: '+stage+'. Тип: '+safeErrorCode(error)+'. Версия: '+BUILD+'.');
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
  }catch(e){diagnostic('local_http',e);response.writeHead(200,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify({version:'1.0',response:{text:'Ошибка обработки запроса.',end_session:false}}));}
});
if(process.env.RUN_HTTP_SERVER==='1') server.listen(Number(process.env.PORT||8080));
export async function handler(event) {
  if(!verifyWebhook(event)) return {statusCode:403,body:'Forbidden'};
  let stage='decode_payload';
  try {
    const rawBody=event.isBase64Encoded && typeof event.body==='string' ? Buffer.from(event.body,'base64').toString('utf8') : event.body;
    const payload=typeof rawBody==='string'?JSON.parse(rawBody):rawBody;
    stage='validate_payload';
    if(!payload || typeof payload!=='object') throw new Error('Invalid payload');
    stage='handle_request';
    const answer=await handle(payload);
    stage='serialize_response';
    return {statusCode:200,headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify(answer)};
  } catch(error) {
    diagnostic('handler',error);
    if(error instanceof SyntaxError || error.message==='Invalid payload') return {statusCode:400,body:'Bad Request'};
    return {statusCode:200,headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify({version:'1.0',response:{text:'Внутренняя ошибка Джарвиса. Этап: '+(typeof stage==='string'?stage:'handler')+'. Тип: '+safeErrorCode(error)+'. Версия: '+BUILD+'.',end_session:false}})};
  }
}
