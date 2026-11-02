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
    const command=validateAiFoodCommand(JSON.parse(raw));
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
    if(!response.ok)return {status:'unavailable',httpStatus:response.status};
    const data=await response.json();
    const models=(Array.isArray(data.models)?data.models:[])
      .filter(m=>Array.isArray(m.supportedGenerationMethods)&&m.supportedGenerationMethods.includes('generateContent'))
      .map(m=>m.name).filter(n=>typeof n==='string').slice(0,12);
    return {status:'ok',models};
  }catch(error){
    return {status:'unavailable',reason:error?.name==='AbortError'?'timeout':error?.cause?.code==='ENOTFOUND'?'dns_failed':'network_error'};
  }finally{clearTimeout(timer)}
}
