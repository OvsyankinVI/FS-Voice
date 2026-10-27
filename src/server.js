import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {fitnessTools} from './fitness-tools.js';
import {GoogleAuth} from 'google-auth-library';
import {todayMoscow,nutritionForDay,targetsFromSettings,targetsFromSite,intent,speak} from './core.js';
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
function aliceResponse(req,text,endSession=false) {
  return {version:req.version||'1.0',session:req.session, response:{text,tts:text,end_session:endSession}};
}
export async function handle(req) {
  const id=req?.session?.user?.user_id || req?.session?.user_id;
  if(!allowed.length || !id || !allowed.includes(id))
    return aliceResponse(req,'Доступ к этому дневнику не разрешён.',true);
  const phrase=req?.request?.original_utterance||'';
  if(req?.session?.new && !phrase.trim()) return aliceResponse(req,'Привет! Спроси про калории, белки или питание за сегодня.');
  try {
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
// Diagnostic output is available only to a deliberately crafted cloud-console test
// with the webhook secret AND a separate private diagnostic secret.
function diagnosticError(error) {
  const message=String(error?.message||'');
  const match=message.match(/HTTP\\s+(\\d{3})/);
  if(match) return 'HTTP '+match[1];
  if(error?.name==='TimeoutError'||error?.name==='AbortError') return 'timeout';
  if(message==='Supabase is not configured') return 'missing_supabase_configuration';
  return 'connection_or_response_error';
}
function matchesDiagnosticSecret(candidate,secret) {
  if(typeof candidate!=='string'||!candidate) return false;
  const a=Buffer.from(candidate),b=Buffer.from(secret);
  return a.length===b.length && timingSafeEqual(a,b);
}
async function diagnoseSupabase() {
  const result={nutrition:'not_checked',targets:'not_checked'};
  const day=todayMoscow();
  for(const [name,operation] of [
    ['nutrition',()=>fitnessTools.getTodayNutrition(day)],
    ['targets',()=>fitnessTools.getTargets()]
  ]) {
    try {await operation();result[name]='ok';}
    catch(error) {result[name]=diagnosticError(error);}
  }
  return result;
}
export async function handler(event) {
  if(!verifyWebhook(event)) return {statusCode:403,body:'Forbidden'};
  const diagnosticSecret=process.env.JARVIS_DIAGNOSTIC_SECRET;
  const diagnosticRequested=event?.queryStringParameters?.diagnostic==='supabase';
  if(diagnosticRequested) {
    if(!diagnosticSecret || !matchesDiagnosticSecret(event?.queryStringParameters?.diagnostic_key,diagnosticSecret)) return {statusCode:403,body:'Forbidden'};
    const result=await diagnoseSupabase();
    return {statusCode:200,headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify(result)};
  }
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
