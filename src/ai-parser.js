// Optional Gemini command interpreter. Read-only: never performs database writes.
// Disabled by default. Keep API keys exclusively in server environment variables.
const MODEL_RE=/^[a-zA-Z0-9._-]+$/;
const UNITS=new Set(['g','ml','pcs','portion']);
const MEALS=new Set(['Завтрак','Обед','Ужин','Перекус']);
export function validateAiFoodCommand(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.intent!=='add_food'||!Array.isArray(value.items)||value.items.length<1||value.items.length>12)return null;
  if(value.meal!==null&&value.meal!==undefined&&!MEALS.has(value.meal))return null;
  const items=[];
  for(const item of value.items){
    if(!item||typeof item.name!=='string'||item.name.trim().length<2||item.name.length>120||!UNITS.has(item.unit)||typeof item.quantity!=='number'||!Number.isFinite(item.quantity)||item.quantity<=0||item.quantity>10000)return null;
    if((item.unit==='pcs'||item.unit==='portion')&&!Number.isInteger(item.quantity))return null;
    items.push({name:item.name.trim(),quantity:item.quantity,unit:item.unit});
  }
  return {intent:'add_food',meal:value.meal||null,items};
}
// Only expose known error categories, never raw provider messages or credentials.
async function classifyGeminiHttpError(response){
  let code='unknown';
  try{
    const body=await response.json();
    const status=String(body?.error?.status||'');
    const message=String(body?.error?.message||'');
    if(!body?.error)code='non_google_error';
    if(/API_KEY_INVALID|API key not valid/i.test(status+' '+message))code='invalid_api_key';
    else if(/API_KEY_SERVICE_BLOCKED|SERVICE_DISABLED|API has not been used|not enabled/i.test(status+' '+message))code='api_disabled';
    else if(/location is not supported|region|country not supported/i.test(message))code='region_restricted';
    else if(/not found|not supported for generateContent/i.test(message))code='model_not_found';
    else if(/quota|rate limit|RESOURCE_EXHAUSTED/i.test(status+' '+message))code='quota';
    else if(/permission|PERMISSION_DENIED/i.test(status+' '+message))code='permission_denied';
    else if(/INVALID_ARGUMENT/i.test(status))code='invalid_request';
  }catch{}
  return {status:'unavailable',httpStatus:response.status,reason:code};
}
export async function parseWithGemini(phrase,{fetchImpl=globalThis.fetch,apiKey=process.env.GEMINI_API_KEY,model=process.env.GEMINI_MODEL||'gemini-2.5-flash',timeoutMs=6000}={}){
  if(process.env.AI_ENABLED!=='true'||!apiKey)return {status:'disabled'};
  if(typeof phrase!=='string'||phrase.length<2||phrase.length>1200||!MODEL_RE.test(model))return {status:'invalid_input'};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const url='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent';
    const response=await fetchImpl(url,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},body:JSON.stringify({
      systemInstruction:{parts:[{text:'Извлеки команду добавления питания из русской фразы. Верни только JSON. intent всегда add_food. meal: Завтрак, Обед, Ужин, Перекус или null. items: массив {name,quantity,unit}, unit только g, ml, pcs, portion. Не придумывай количество или единицы. Если количества нет или запрос не о записи питания, верни {"intent":"unsupported","meal":null,"items":[]}. Не вычисляй КБЖУ и не утверждай, что запись сохранена.'}]},
      contents:[{role:'user',parts:[{text:phrase}]}],
      generationConfig:{temperature:0,responseMimeType:'application/json',maxOutputTokens:512}
    })});
    if(!response.ok)return await classifyGeminiHttpError(response);
    const payload=await response.json();
    const raw=payload?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('');
    if(!raw)return {status:'invalid_response'};
    const data=JSON.parse(raw);
    if(data?.intent==='add_food'&&Array.isArray(data.items)&&data.items.length>0&&data.items.length<=12){
      const missing=data.items.filter(item=>item&&typeof item.name==='string'&&(item.quantity===null||item.quantity===undefined))
        .map(item=>item.name.trim()).filter(name=>name.length>=2&&name.length<=120);
      if(missing.length)return {status:'missing_amount',missing,partial:{meal:data.meal,items:data.items}};
    }
    const command=validateAiFoodCommand(data);
    return command?{status:'parsed',command}:{status:'unsupported'};
  }catch(error){return {status:'unavailable',reason:error?.name==='AbortError'?'timeout':error instanceof SyntaxError?'invalid_json':error?.cause?.code==='ENOTFOUND'?'dns_failed':error?.cause?.code==='ETIMEDOUT'?'network_timeout':'network_error'}}
  finally{clearTimeout(timer)}
}

export async function listGeminiModels({fetchImpl=globalThis.fetch,apiKey=process.env.GEMINI_API_KEY,timeoutMs=6000}={}){
  if(process.env.AI_ENABLED!=='true')return {status:'disabled'};
  if(!apiKey)return {status:'missing_key'};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models',{
      headers:{'x-goog-api-key':apiKey},signal:controller.signal
    });
    if(!response.ok)return await classifyGeminiHttpError(response);
    const data=await response.json();
    const models=(Array.isArray(data.models)?data.models:[])
      .filter(m=>Array.isArray(m.supportedGenerationMethods)&&m.supportedGenerationMethods.includes('generateContent'))
      .map(m=>m.name).filter(n=>typeof n==='string').slice(0,12);
    return {status:'ok',models};
  }catch(error){
    return {status:'unavailable',reason:error?.name==='AbortError'?'timeout':error?.cause?.code==='ENOTFOUND'?'dns_failed':'network_error'};
  }finally{clearTimeout(timer)}
}

export async function parseWithYandex(phrase,{fetchImpl=globalThis.fetch,apiKey=process.env.YANDEX_AI_API_KEY,folderId=process.env.YANDEX_FOLDER_ID,model=process.env.YANDEX_AI_MODEL||'yandexgpt-5.1',timeoutMs=8000}={}){
  if(process.env.AI_ENABLED!=='true')return {status:'disabled'};
  if(!apiKey||!folderId)return {status:'missing_config'};
  if(typeof phrase!=='string'||phrase.length<2||phrase.length>1200||!MODEL_RE.test(model)||!/^[a-zA-Z0-9_-]+$/.test(folderId))return {status:'invalid_input'};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl('https://ai.api.cloud.yandex.net/v1/chat/completions',{
      method:'POST',signal:controller.signal,
      headers:{'Content-Type':'application/json','Authorization':'Api-Key '+apiKey,'OpenAI-Project':folderId},
      body:JSON.stringify({
        model:'gpt://'+folderId+'/'+model,
        messages:[
          {role:'system',content:'Извлеки команду добавления питания из русской фразы. Ответь только валидным JSON объектом с полями intent, meal, items. intent=add_food; meal: Завтрак, Обед, Ужин, Перекус или null; items: массив объектов {name,quantity,unit}, unit только g, ml, pcs, portion. Не придумывай количество или единицы. Если запрос не о записи питания, верни {"intent":"unsupported","meal":null,"items":[]}. Если для отдельного продукта количество не названо, укажи quantity:null и unit:null именно для этого продукта; остальные продукты сохрани с указанными количествами. Для кофе с молоком без указанного объёма не выдумывай объём. Не вычисляй КБЖУ и не утверждай, что запись сохранена.'},
          {role:'user',content:phrase}
        ],temperature:0,max_tokens:400,stream:false
      })
    });
    if(!response.ok)return {status:'unavailable',httpStatus:response.status};
    const payload=await response.json();
    let raw=payload?.choices?.[0]?.message?.content;
    if(typeof raw!=='string')return {status:'invalid_response'};
    raw=raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,'').replace(/\s*\x60\x60\x60$/,'');
    const data=JSON.parse(raw);
    if(data?.intent==='add_food'&&Array.isArray(data.items)&&data.items.length>0&&data.items.length<=12){
      const missing=data.items.filter(item=>item&&typeof item.name==='string'&&(item.quantity===null||item.quantity===undefined))
        .map(item=>item.name.trim()).filter(name=>name.length>=2&&name.length<=120);
      if(missing.length)return {status:'missing_amount',missing};
    }
    const command=validateAiFoodCommand(data);
    return command?{status:'parsed',command}:{status:'unsupported'};
  }catch(error){return {status:'unavailable',reason:error?.name==='AbortError'?'timeout':error instanceof SyntaxError?'invalid_json':'network_error'}}
  finally{clearTimeout(timer)}
}
