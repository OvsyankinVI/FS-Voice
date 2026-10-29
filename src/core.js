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

export function parseFoodCommand(input) {
  const raw=String(input??'').trim().toLowerCase().replace(/ё/g,'е');
  const match=raw.match(/(?:запиши|добавь|съел|съела|ел|ела)\s+(.+?)\s*$/i);
  if(!match)return null;
  let text=match[1].replace(/^(?:мне|в дневник|в питание)\s+/,'');
  const quantity=text.match(/(\d+(?:[.,]\d+)?)\s*(килограмм(?:а|ов)?|кг|грамм(?:а|ов)?|гр|г)(?=$|[\s,;.!?])/);
  if(!quantity)return {status:'missing_amount'};
  let grams=Number(quantity[1].replace(',','.'))*(quantity[2].startsWith('к')?1000:1);
  if(!Number.isFinite(grams)||grams<=0||grams>10000)return {status:'invalid_amount'};
  let meal=null;
  const mealMatch=text.match(/(?:на|в качестве)\s+(завтрак|обед|ужин|перекус)\b/);
  if(mealMatch)meal=mealMatch[1];
  text=text.replace(quantity[0],' ').replace(/(?:на|в качестве)\s+(?:завтрак|обед|ужин|перекус)\b/,' ').replace(/\s+/g,' ').trim();
  text=text.replace(/^(?:из|по|с)\s+/,'').trim();
  if(text.length<2)return {status:'missing_product'};
  return {status:'parsed',name:text,grams,meal};
}

export function parseFoodBatch(input) {
  const raw=String(input??'').trim().toLowerCase().replace(/ё/g,'е');
  const m=raw.match(/(?:запиши|добавь|съел|съела|ел|ела)\s+(.+)$/i);
  if(!m)return null;
  let body=m[1].replace(/^(?:мне|в дневник|в питание)\s+/,'').replace(/^(?:владу|владиславу|ангелине|ангелину)\s+/,'');
  const mealMatch=body.match(/(?:на|в качестве)\s+(завтрак|обед|ужин|перекус)\b/);
  const meal=mealMatch?.[1]||'перекус';
  body=body.replace(/(?:на|в качестве)\s+(?:завтрак|обед|ужин|перекус)\b/,'');
  // Count-based homemade syrniki: API uses 1 pseudo-gram per piece, not real weight.
  const syrniki=body.trim().match(/^(\d{1,3})\s*(?:сырник(?:а|ов)?|сырничк(?:а|ов)?)\s*[.!?]*$/u);
  if(syrniki){
    const count=Number(syrniki[1]);
    return count>=1&&count<=100 ? {status:'parsed',items:[{name:'Сырник домашний (1 штука)',grams:count,meal:'завтрак'}]} : {status:'invalid_amount'};
  }
  // A saved recipe can be added as one serving without a gram amount. 
  if (/^завтрак с бутербродом[.!?\s]*$/u.test(body.trim())) return {status:'parsed',items:[{name:'Завтрак с бутербродом',grams:1,meal:'завтрак'}]};
  const pieces=body.split(/\s*(?:,|;|\s+и\s+)\s*/).map(x=>x.trim()).filter(Boolean);
  if(pieces.length>10)return {status:'too_many'};
  const items=[];
  for(const piece of pieces){
    const quantity=piece.match(/(\d+(?:[.,]\d+)?)\s*(килограмм(?:а|ов)?|кг|грамм(?:а|ов)?|гр|г)(?=$|[\s,;.!?])/);
    if(!quantity)return {status:'missing_amount',product:piece};
    const grams=Number(quantity[1].replace(',','.'))*(quantity[2].startsWith('к')?1000:1);
    if(!Number.isFinite(grams)||grams<=0||grams>10000)return {status:'invalid_amount'};
    const name=piece.replace(quantity[0],' ').replace(/^(?:из|по|с)\s+/,'').replace(/\s+(?:владу|владиславу|ангелине|ангелину)$/,'').replace(/\s+/g,' ').trim();
    if(name.length<2)return {status:'missing_product'};
    items.push({name,grams,meal});
  }
  return {status:'parsed',items};
}
