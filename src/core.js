export const MOSCOW_TZ = 'Europe/Moscow';
export function todayMoscow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:MOSCOW_TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function parseDate(value) {
  const s=String(value??'').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m=s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
export function number(value) {
  if (value===null || value===undefined || String(value).trim()==='') return null;
  const n=Number(String(value).replace(/\s/g,'').replace(',','.'));
  return Number.isFinite(n)?n:null;
}
export function nutritionForDay(rows, date) {
  const found=rows.slice(1).filter(r=>parseDate(r[0])===date);
  if (!found.length) return {status:'missing_day',date};
  if (found.length!==1) return {status:'duplicate_day',date};
  const r=found[0], keys=['kcal','protein','fat','carbs'];
  const consumed=Object.fromEntries(keys.map((k,i)=>[k,number(r[i+2])]));
  if(keys.some(k=>consumed[k]===null)) return {status:'incomplete_day',date};
  return {status:'ok',date,consumed};
}
export function targetsFromSettings(rows) {
  // Dedicated exact targets are optional; never confuse min/max ranges with a precise goal.
  const map=new Map(rows.map(r=>[String(r[0]??'').trim().toLowerCase(),number(r[1])]));
  const names={kcal:'Цель калорий',protein:'Цель белка',fat:'Цель жиров',carbs:'Цель углеводов'};
  if(Object.values(names).every(n=>map.get(n.toLowerCase())>0))
    return Object.fromEntries(Object.entries(names).map(([k,n])=>[k,map.get(n.toLowerCase())]));
  return null;
}
export function targetsFromSite(data) {
  const t=data?.target;
  if(!t) return null;
  const keys=['kcal','protein','fat','carbs'];
  const result=Object.fromEntries(keys.map(k=>[k,number(Array.isArray(t[k])?t[k][0]:t[k])]));
  return keys.every(k=>result[k]>0)?result:null;
}
export function intent(text) {
  const s=String(text??'').toLowerCase().replace(/ё/g,'е');
  if(/(все|общ|питан|кбжу|макрос)/.test(s)) return 'summary';
  if(/(белк|протеин)/.test(s)) return 'protein';
  if(/(жир)/.test(s)) return 'fat';
  if(/(углевод)/.test(s)) return 'carbs';
  if(/(калори|килокалори|ккал)/.test(s)) return 'kcal';
  return 'help';
}
const labels={kcal:'калорий',protein:'белка',fat:'жиров',carbs:'углеводов'};
const units={kcal:'килокалорий',protein:'граммов',fat:'граммов',carbs:'граммов'};
const round=n=>Math.round(n);
export function speak(result,targets,kind) {
  if(result.status==='missing_day') return 'За сегодня пока нет записи о питании.';
  if(result.status==='duplicate_day') return 'За сегодня найдено несколько записей. Нужно проверить дневник.';
  if(result.status==='incomplete_day') return 'Сегодняшняя запись есть, но данные о питании заполнены не полностью.';
  if(result.status!=='ok') return 'Сейчас не удалось получить данные дневника. Попробуй позже.';
  if(!targets) return 'Не удалось получить дневные цели.';
  const item=k=>{
    const used=round(result.consumed[k]), goal=round(targets[k]), diff=round(result.consumed[k]-targets[k]);
    return diff>0 ? `По ${labels[k]} превышение на ${diff} ${units[k]}.` : `${labels[k]}: ${used} из ${goal}. Осталось ${round(Math.max(0,targets[k]-result.consumed[k]))}.`;
  };
  if(kind==='summary') return ['kcal','protein','fat','carbs'].map(item).join(' ');
  if(!labels[kind]) return 'Могу назвать остаток калорий, белков, жиров, углеводов или всё питание за сегодня.';
  const used=round(result.consumed[kind]), diff=result.consumed[kind]-targets[kind];
  return diff>0 ? `Сегодня ${labels[kind]}: ${used} ${units[kind]}. Превышение на ${round(diff)}.` :
    `Сегодня ${labels[kind]}: ${used} ${units[kind]}. Осталось ${round(Math.max(0,-diff))}.`;
}
