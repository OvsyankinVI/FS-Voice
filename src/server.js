import http from 'node:http';
import {AsyncLocalStorage} from 'node:async_hooks';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {fitnessTools} from './fitness-tools.js';

import {todayMoscow,nutritionForDay,targetsFromSettings,targetsFromSite,intent,speak,parseFoodCommand,parseFoodBatch,convertFoodQuantity} from './core.js';
const sheetId=process.env.SPREADSHEET_ID;
const siteUrl=process.env.TARGETS_JSON_URL || 'https://ovsyankinvi.github.io/FS/data.json';
const allowed=(process.env.ALLOWED_ALICE_USER_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
const webhookSecret=process.env.ALICE_WEBHOOK_SECRET||'';
const BUILD='0.4.8-numbered-choices-20261030';
const auditContext=new AsyncLocalStorage();
function diagnostic(stage,error){
  const context=auditContext.getStore();
  if(context)context.push({stage,code:safeErrorCode(error),message:String(error?.message||error||'unknown').replace(/(sb_secret_[a-zA-Z0-9_-]+|Bearer\s+\S+|https?:\/\/\S+|[a-zA-Z0-9_-]{80,})/g,'[REDACTED]').slice(0,280)});
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
function auditReply(req,answer,issues) {
  if(process.env.FS_VOICE_AUDIT_ENABLED!=='true')return answer;
  const userId=req?.session?.user?.user_id||req?.session?.user_id;
  if(!userId||!allowed.includes(userId))return answer;
  const record={
    request_id:randomUUID(),
    alice_user_id:userId,
    session_id:String(req?.session?.session_id||'').slice(0,128)||null,
    message_id:Number.isInteger(req?.session?.message_id)?req.session.message_id:null,
    request_text:String(req?.request?.original_utterance||'').slice(0,3000),
    response_text:String(answer?.response?.text||'').slice(0,4000),
    build_version:BUILD,
    outcome:issues.length||/(?:не наш[её]л|не удалось|не могу|ошибка|ничего не (?:изменено|записано)|нет ожидающей|наш[её]л несколько|наш[её]л \d+ похожих|укажи массу|уточни)/iu.test(String(answer?.response?.text||''))?'error':'ok',
    technical_details:issues.length?{errors:issues.slice(0,5)}:null
  };
  // Best effort: audit failure must not change Alice's answer.
  return fitnessTools.logVoiceRequest(record).catch(error=>console.error('[FS-Voice]',BUILD,'audit_write_failed',safeErrorCode(error))).then(()=>answer);
}
function aliceResponse(req,text,endSession=false,state=null) {
  const answer={version:req.version||'1.0',session:req.session,response:{text,tts:text,end_session:endSession}};
  if(state){answer.session_state=state;answer.user_state_update=state;}
  return answer;
}

async function handleCore(req) {
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
    const numberedChoice=(utterance)=>{
      const cleaned=String(utterance).toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[.!?]/g,'').trim();
      const map={'1':1,'один':1,'одна':1,'первый':1,'первую':1,'первое':1,'2':2,'два':2,'второй':2,'вторую':2,'второе':2,'3':3,'три':3,'третий':3,'третью':3,'третье':3,'4':4,'четыре':4,'четвертый':4,'четвертую':4,'5':5,'пять':5,'пятый':5,'6':6,'шесть':6,'шестой':6,'7':7,'семь':7,'седьмой':7,'8':8,'восемь':8,'восьмой':8,'9':9,'девять':9,'девятый':9,'10':10,'десять':10,'десятый':10};
      return map[cleaned.replace(/^(?:номер|вариант|запись)\s+/u,'')]||null;
    };
    const unitName=u=>({g:'граммов',ml:'миллилитров',pcs:'штук',portion:'порций'}[u]||'единиц');
    const stageEdit=async(owner,row,action,grams)=>{
      const unit=row.source_extra?.unit||(/сырник/iu.test(row.display_name||'')?'pcs':/^(?:завтрак с бутербродом|кофе с банановым молоком)$/iu.test(row.display_name||'')?'portion':'g');
      stage='stage_voice_edit';
      await fitnessTools.stageVoiceEdit({aliceUserId:id,ownerId:owner.owner_id,logId:row.id,action,grams});
      const message=(action==='delete'?'Удалить':'Изменить')+' для '+owner.display_name+': '+row.display_name+', '+(row.source_extra?.grams??'количество неизвестно')+' '+unitName(unit)+(action==='update'?' на '+grams+' '+unitName(unit):'')+'? Скажи да или нет.';
      return aliceResponse(req,message,false,{fs_edit_pending:{version:1,alice_user_id:id,owner_id:owner.owner_id,log_id:row.id,action,grams,unit}});
    };
    // Durable numbered selections survive Alice starting a fresh session.
    if(/^(?:[1-9]|10|один|одна|два|три|четыре|пять|шесть|семь|восемь|девять|десять|первый|первую|второй|вторую|третий|третью|четвертый|четвертую|пятый|шестой|седьмой|восьмой|девятый|десятый|номер\s+\S+|вариант\s+\S+|запись\s+\S+|отмена выбора)[.!?\s]*$/iu.test(phrase.trim())){
      stage='load_numbered_choice';
      const choice=await fitnessTools.getVoiceChoice(id);
      if(choice){
        if(/^отмена выбора$/iu.test(phrase.trim())){await fitnessTools.clearVoiceChoice(id);return aliceResponse(req,'Отменил выбор.');}
        const number=numberedChoice(phrase);
        if(!number||number>choice.choices.length)return aliceResponse(req,'Назови номер от одного до '+choice.choices.length+'.');
        const selected=choice.choices[number-1];
        await fitnessTools.clearVoiceChoice(id);
        if(choice.kind==='edit'){
          const owner=members.find(m=>m.owner_id===choice.owner_id);
          if(!owner)return aliceResponse(req,'Дневник больше недоступен.');
          const rows=await fitnessTools.listTodayFoodLogs(owner.owner_id,todayMoscow());
          const row=rows.find(x=>x.id===selected.id);
          if(!row)return aliceResponse(req,'Выбранная запись уже отсутствует. Повтори команду.');
          const unit=row.source_extra?.unit||'g';
          if(choice.context.action==='update'&&choice.context.unit&&choice.context.unit!==unit)return aliceResponse(req,'Единица измерения выбранной записи не совпадает. Повтори команду.');
          return stageEdit(owner,row,choice.context.action,choice.context.grams);
        }
      }
    }
    const namedRecipient=String(phrase).toLocaleLowerCase('ru').replace(/ё/g,'е').match(/\b(?:для|в|к)\s+(ангелины|ангелине|ангелину|влада|владу|владислава|владиславу)\b/u);
    if(namedRecipient&&!recipientOf(phrase).length)return aliceResponse(req,'Профиль '+namedRecipient[1]+' пока не подключён. Ничего не записано.');
    const resolveItems=async(ownerId,items)=>{
      const selected=[];
      for(const item of items){
        const name=item.name.replace(/^(?:для\s+)?(?:влада|владу|владислава|владиславу|ангелины|ангелине|ангелину)\s+/iu,'').replace(/\s+(?:для\s+)?(?:влада|владу|владислава|владиславу|ангелины|ангелине|ангелину)$/iu,'').trim();
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
        const unit=item.unit||'g';
        let amount=item.grams;
        if(unit==='g' && f.kind==='personal' && ['portion','pcs','ml'].includes(f.source_extra?.voice_unit))return {error:'Не могу записать «'+f.name+'» в граммах: в каталоге продукт измеряется в '+({portion:'порциях',pcs:'штуках',ml:'миллилитрах'})[f.source_extra.voice_unit]+', а коэффициент пересчёта в граммы не указан. Скажи количество в '+({portion:'порциях',pcs:'штуках',ml:'миллилитрах'})[f.source_extra.voice_unit]+'. Ничего не записано.'};
        if(unit!=='g'){
          if(f.kind!=='personal')return {error:'Не могу записать «'+f.name+'» в '+({ml:'миллилитрах',pcs:'штуках',portion:'порциях'})[unit]+': найденный продукт рассчитан на 100 граммов, но его плотность или размер порции неизвестны. Добавь продукт с нужной единицей в личный каталог либо назови массу в граммах. Ничего не записано.'};
          const metadata=f.source_extra||{};
          const legacy=f.name==='Сырник домашний'?'pcs':f.name==='Завтрак с бутербродом'?'portion':null;
          const basisUnit=metadata.voice_unit||legacy;
          const converted=convertFoodQuantity({amount:item.grams,unit},{source_extra:{...metadata,voice_unit:basisUnit,voice_basis_amount:metadata.voice_basis_amount||1}});
          if(!converted)return {error:'Не могу записать «'+f.name+'»: ты указал '+({ml:'миллилитры',pcs:'штуки',portion:'порции'})[unit]+', а в каталоге единица «'+(basisUnit||'не задана')+'». Не указана масса штуки, объём порции или другой подтверждённый коэффициент пересчёта. Уточни количество в единицах каталога. Ничего не записано.'};
          amount=converted.basisAmount;
        }
        selected.push({kind:f.kind,product_id:f.product_id,fdc_id:f.fdc_id,grams:amount,meal:({завтрак:'Завтрак',обед:'Обед',ужин:'Ужин',перекус:'Перекус'})[item.meal]||'Перекус',entry_key:randomUUID(),name:f.name});
      }
      return {selected};
    };
    const prepare=async(owner,items)=>{
      const result=await resolveItems(owner.owner_id,items);
      if(result.error)return aliceResponse(req,result.error);
      stage='stage_confirmation';
      await fitnessTools.stageConfirmation({aliceUserId:id,ownerId:owner.owner_id,items:result.selected.map(({name,...item})=>item)});
      const summary=items.map((item,i)=>result.selected[i].name+' '+item.grams+({g:' г',ml:' мл',pcs:' шт.',portion:' порц.'}[item.unit||'g']||' г')).join(', ');
      return aliceResponse(req,'Добавить для '+owner.display_name+': '+summary+'? Скажи да или нет.',false,{fs_batch_pending:{version:1,alice_user_id:id,owner_id:owner.owner_id,items:result.selected}});
    };
    // Correction of a previously logged count-based serving, not a new food entry.
    const countCorrection=null; // The general correction parser below handles this durably.
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
    const eatenCorrection=phrase.trim().toLocaleLowerCase('ru').replace(/ё/g,'е').match(/^(?:я\s+)?(?:съел|съела|поел|поела)\s+не\s+(\d{1,3})\s+сырник(?:а|ов)?,?\s+а\s+(\d{1,3})(?:\s+сырник(?:а|ов)?)?[.!?\s]*$/iu);
    const correctionOld=eatenCorrection?Number(eatenCorrection[1]):null;
    const correctionNew=eatenCorrection?Number(eatenCorrection[2]):null;
    if(eatenCorrection&&(correctionOld<1||correctionNew<1||correctionOld>100||correctionNew>100))return aliceResponse(req,'Укажи количество сырников от одного до ста.');
    const correctionPhrase=eatenCorrection?'измени сырник домашний с '+correctionOld+' на '+correctionNew+' штуки':phrase.trim();
    const editMatch=correctionPhrase.match(/^(?:(?:джарвис|пожалуйста)[, ]+)?(измени(?:ть)?|поменяй|исправь|удали(?:ть)?|убери)\s+(?:(?:вес|массу)\s+)?(.+?)\s*$/iu);
    if(editMatch){
      const action=/^(удал|убер)/iu.test(editMatch[1])?'delete':'update';
      let rest=editMatch[2].replace(/\s+(?:(?:из|в)\s+)?(?:сегодняшнего\s+)?дневника.*$/iu,'').replace(/\s+(?:там\s+)?(?:(?:из|с)\s+)?сегодняшнего\s+дневника.*$/iu,'').trim();
      const mass=rest.match(/\s+(?:со?\s+\d+(?:[.,]\d+)?\s*(?:грамм(?:ов|а)?|г|шт\.?|штук(?:и|у)?|порци(?:я|и|й|ю)|мл|миллилитр(?:ов|а)?|л|литр(?:ов|а)?)?\s*)?(?:на|до)\s+(\d+(?:[.,]\d+)?)\s*(?:грамм(?:ов|а)?|г|шт\.?|штук(?:и|у)?|порци(?:я|и|й|ю)|мл|миллилитр(?:ов|а)?|л|литр(?:ов|а)?)?$/iu);
      const rawAmount=mass?Number(mass[1].replace(',','.')):null;
      const statedUnit=mass?.[0]?.match(/(?:мл|миллилитр(?:ов|а)?|литр(?:ов|а)?|\bл\b|порци(?:я|и|й|ю)|шт\.?|штук(?:и|у)?|грамм(?:ов|а)?|\bг\b)\s*$/iu)?.[0]?.trim()||'';
      const editUnit=eatenCorrection?'pcs':!statedUnit?null:/^(?:л|литр)/iu.test(statedUnit)?'l':/^(?:мл|миллилитр)/iu.test(statedUnit)?'ml':/^порци/iu.test(statedUnit)?'portion':/^(?:шт|штук)/iu.test(statedUnit)?'pcs':'g';
      const grams=rawAmount*(editUnit==='l'?1000:1);
      if(action==='update'&&(!Number.isFinite(grams)||grams<=0||grams>10000))return aliceResponse(req,'Назови новую массу, например: измени вес банана со 100 на 150 граммов.');
      const previousFromMass=mass?.[0]?.match(/(?:^|\s)со?\s+(\d+(?:[.,]\d+)?)/iu);
      if(mass)rest=rest.slice(0,mass.index).trim();
      if(eatenCorrection)rest='сырник домашний';
      const oldMass=rest.match(/\s+со?\s+(\d+(?:[.,]\d+)?)\s*(?:грамм(?:ов|а)?|г|шт\.?|штук(?:и|у)?|порци(?:я|и|й|ю)|мл|миллилитр(?:ов|а)?|л|литр(?:ов|а)?)?$/iu);
      const previous=eatenCorrection?correctionOld:previousFromMass?Number(previousFromMass[1].replace(',','.')):oldMass?Number(oldMass[1].replace(',','.')):null;
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
      const stem=x=>norm(x).split(' ').filter(Boolean).map(w=>w.slice(0,Math.max(3,w.length-2)));
      const words=stem(rest);
      const found=rows.filter(row=>{
        const name=norm(row.display_name||row.original_text);
        const matches=words.every(w=>name.split(' ').some(token=>token.startsWith(w)||w.startsWith(token.slice(0,Math.max(3,token.length-2)))));
        const weight=Number(row.source_extra?.grams);
        return matches&&(previous===null||weight===previous)&&(!meal||norm(row.meal_type).includes(norm(meal[1]).slice(0,4)));
      });
      if(!found.length)return aliceResponse(req,'Не нашёл подходящую запись за сегодня. Ничего не изменено.');
      if(found.length>1){
        const options=found.slice(0,10);
        await fitnessTools.stageVoiceChoice({aliceUserId:id,ownerId:owner.owner_id,kind:'edit',choices:options.map(x=>({id:x.id})),context:{action,grams,unit:editUnit==='l'?'ml':editUnit}});
        return aliceResponse(req,'Нашёл '+found.length+' похожих записей: '+options.map((x,i)=>(i+1)+': '+x.display_name+', '+(x.source_extra?.grams??'количество неизвестно')+' '+unitName(x.source_extra?.unit||'g')+', '+(x.meal_type||'приём пищи не указан')).join('; ')+'. Назови номер записи: первый, второй и так далее.');
      }
      const row=found[0];
      const rowUnit=row.source_extra?.unit||'g';
      const effectiveUnit=editUnit===null?rowUnit:editUnit==='l'?'ml':editUnit;
      if(action==='update'&&effectiveUnit!==rowUnit)return aliceResponse(req,'У этой записи другая единица измерения. Укажи количество в '+unitName(rowUnit)+'.');
      return stageEdit(owner,row,action,grams);
    }
    const editPending=state.fs_edit_pending;
    if(editPending?.version===1&&editPending.alice_user_id===id){
      if(/^(нет|отмена|отмени)$/iu.test(phrase.trim())){await fitnessTools.cancelConfirmation(id);return aliceResponse(req,'Отменил изменение.');}
      if(/^(да|подтверждаю|верно)$/iu.test(phrase.trim())){
        {
          const durable=await fitnessTools.confirmVoiceEdit(id);
          if(durable?.status==='ok')return aliceResponse(req,'Готово! Изменение в дневнике сохранено.');
        }
        if(!members.some(m=>m.owner_id===editPending.owner_id))return aliceResponse(req,'Дневник больше недоступен.');
        stage='edit_food';
        const result=await fitnessTools.editTodayFood({aliceUserId:id,ownerId:editPending.owner_id,logId:editPending.log_id,action:editPending.action,grams:editPending.grams});
        return aliceResponse(req,result?.status==='ok'?'Готово! '+(editPending.action==='delete'?'Удалил продукт из дневника.':'Изменил массу продукта в дневнике.'):'Не удалось изменить запись: '+(result?.status||'не найдена')+'.');
      }
    }
    if(/^(да|подтверждаю|верно)$/iu.test(phrase.trim())){
      stage='confirm_voice_edit';
      const edit=await fitnessTools.confirmVoiceEdit(id);
      if(edit?.status==='ok')return aliceResponse(req,'Готово! Изменение в дневнике сохранено.');
      if(edit?.status==='expired')return aliceResponse(req,'Подтверждение изменения устарело. Повтори команду.');
      if(edit?.status==='unsupported')return aliceResponse(req,'Эту запись пока нельзя изменить по голосу.');
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
      const chosen=recipientOf(phrase);
      if(chosen.length>1)return aliceResponse(req,'Назови одного человека, чей дневник показать.');
      const owner=chosen.length===1?chosen[0]:members.length===1?members[0]:null;
      if(!owner)return aliceResponse(req,'Чей дневник показать: '+members.map(m=>m.display_name).join(' или ')+'?');
      const nutrition=await fitnessTools.getTodayNutrition(day,owner.owner_id).catch(error=>{console.error('Supabase nutrition read failed:',error?.message||String(error));throw new Error('nutrition_read_failed');});
      const targets=await fitnessTools.getTargets().catch(error=>{console.error('Supabase targets read failed:',error?.message||String(error));throw new Error('targets_read_failed');});
      return aliceResponse(req,owner.display_name+': '+speak(nutrition,targets,intent(phrase)));
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
export async function handle(req) {
  const issues=[];
  return auditContext.run(issues,async()=>{
    const answer=await handleCore(req);
    return auditReply(req,answer,issues);
  });
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
