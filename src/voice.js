const { CALENDAR_RANGE } = require('./catalog');
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 30;
const TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Qyzylorda';
const key = () => process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
const dateInZone = (now = new Date()) => new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const clean = (s) => String(s || '').normalize('NFKC').trim().toLocaleLowerCase('ru').replace(/[ё]/g,'е').replace(/\s+/g,' ');

function options(catalog) {
  return { cities:[...new Set(catalog.map((p)=>p.city))].sort(),categories:[...new Set(catalog.flatMap((p)=>p.categories))].sort(),formats:[...new Set(catalog.flatMap((p)=>p.eventFormats))].sort(),languages:[...new Set(catalog.flatMap((p)=>p.languages))].sort() };
}
function canonical(value, values, aliases = {}) {
  if(typeof value!=='string'||!value.trim()) return null;
  const found=values.find((item)=>clean(item)===clean(value)) || values.find((item)=>Object.entries(aliases).some(([alias,target])=>clean(alias)===clean(value)&&clean(target)===clean(item)));
  return found || null;
}
function safeInteger(value, min, max) { return Number.isInteger(value)&&value>=min&&value<=max?value:null; }
function validateDraft(raw, catalog, now = new Date()) {
  const allowed=options(catalog), today=dateInZone(now);
  const city=canonical(raw?.city,allowed.cities,{'алматы':'Алматы'});
  const category=canonical(raw?.category,allowed.categories,{'ведущий':'Ведущий','тамада':'Ведущий'});
  const eventFormat=canonical(raw?.eventFormat,allowed.formats,{'корпоратив':'корпоратив'});
  let date=typeof raw?.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(raw.date)&&!Number.isNaN(Date.parse(`${raw.date}T00:00:00Z`))&&new Date(`${raw.date}T00:00:00Z`).toISOString().slice(0,10)===raw.date?raw.date:null;
  const budgetKzt=safeInteger(raw?.budgetKzt,1,100000000);
  const language=canonical(raw?.language,allowed.languages,{'русский':'русский','казахский':'казахский'});
  const durationHours=safeInteger(raw?.durationHours,1,24);
  const preferences=typeof raw?.preferences==='string'?raw.preferences.trim().slice(0,500):'';
  const clarifications=Array.isArray(raw?.clarifications)?raw.clarifications.filter((x)=>typeof x==='string').slice(0,8).map((x)=>x.slice(0,180)):[];
  const add=(field,text)=>{ if(!clarifications.some((x)=>x.startsWith(field+':'))) clarifications.push(`${field}: ${text}`); };
  for(const [field,value,source] of [['Город',city,raw?.city],['Категория',category,raw?.category],['Формат',eventFormat,raw?.eventFormat],['Язык',language,raw?.language]]) if(source && !value) add(field,`«${String(source).slice(0,60)}» отсутствует в каталоге — выберите значение вручную.`);
  if(raw?.date && !date) add('Дата','не удалось однозначно определить дату; уточните её вручную.');
  if(date && (date<CALENDAR_RANGE.min||date>CALENDAR_RANGE.max)) { add('Дата',`должна быть в пределах ${CALENDAR_RANGE.min}–${CALENDAR_RANGE.max}.`); date=null; }
  if(raw?.budgetKzt!=null && !budgetKzt) add('Бюджет','сумма не распознана однозначно; укажите её вручную.');
  if(raw?.durationHours!=null && !durationHours) add('Длительность','укажите число часов от 1 до 24.');
  if(raw?.date && date && date<today) add('Дата','распознанная дата уже прошла; проверьте её.');
  return {suggestions:{city,category,eventFormat,date,budgetKzt,language,durationHours,preferences},clarifications,calendarRange:CALENDAR_RANGE,timeZone:TIME_ZONE};
}

async function transcribeAudio(buffer, mimeType, fetchImpl = fetch) {
  if(!key()) throw Object.assign(new Error('Голосовой AI не настроен.'),{status:503});
  if(!Buffer.isBuffer(buffer)||!buffer.length) throw Object.assign(new Error('Запись пустая.'),{status:400});
  if(buffer.length>MAX_AUDIO_BYTES) throw Object.assign(new Error('Запись превышает 10 МБ.'),{status:413});
  const mime=(mimeType||'').split(';')[0].trim().toLowerCase();
  const ext={'audio/webm':'webm','audio/mp4':'mp4','audio/ogg':'ogg','audio/wav':'wav','audio/mpeg':'mp3','audio/mp3':'mp3'}[mime];
  if(!ext) throw Object.assign(new Error('Формат записи не поддерживается. Используйте браузер Chrome, Edge или Safari.'),{status:415});
  const form=new FormData();
  form.set('file',new Blob([buffer],{type:mime}),`voice.${ext}`);
  form.set('model',process.env.AI_TRANSCRIBE_MODEL||'gpt-transcribe');
  form.set('prompt','Заявки на мероприятия. Возможны русский и казахский языки, названия городов Казахстана, event-форматы и тенге. Сохраняй слова пользователя дословно.');
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),Number(process.env.AI_VOICE_TIMEOUT_MS||30000));
  try {
    const response=await fetchImpl('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${key()}`},body:form,signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||typeof data.text!=='string') throw Object.assign(new Error('Сервис распознавания речи сейчас недоступен.'),{status:502});
    const transcript=data.text.trim();
    if(!transcript) throw Object.assign(new Error('Не удалось распознать речь. Запишите фразу ещё раз.'),{status:422});
    return {transcript:transcript.slice(0,5000)};
  } catch(error) { if(error.name==='AbortError') throw Object.assign(new Error('Распознавание заняло слишком много времени. Попробуйте ещё раз.'),{status:504}); if(error.status) throw error; throw Object.assign(new Error('Не удалось связаться с сервисом распознавания речи.'),{status:502}); }
  finally { clearTimeout(timer); }
}

async function parseTranscript(transcript,catalog,existing={},fetchImpl=fetch,now=new Date()) {
  if(!key()) throw Object.assign(new Error('AI-парсер голосовой заявки не настроен.'),{status:503});
  if(typeof transcript!=='string'||!transcript.trim()||transcript.length>5000) throw Object.assign(new Error('Передайте распознанный текст длиной до 5000 символов.'),{status:400});
  const available=options(catalog), today=dateInZone(now);
  const schema={type:'object',additionalProperties:false,properties:{city:{type:['string','null']},category:{type:['string','null']},eventFormat:{type:['string','null']},date:{type:['string','null']},budgetKzt:{type:['integer','null']},language:{type:['string','null']},durationHours:{type:['integer','null']},preferences:{type:'string'},clarifications:{type:'array',items:{type:'string'}}},required:['city','category','eventFormat','date','budgetKzt','language','durationHours','preferences','clarifications']};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Number(process.env.AI_VOICE_TIMEOUT_MS||30000));
  try {
    const response=await fetchImpl('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key()}`,'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({model:process.env.AI_VOICE_MODEL||'gpt-4o-mini',temperature:0,response_format:{type:'json_schema',json_schema:{name:'event_request',strict:true,schema}},messages:[{role:'system',content:`Extract only facts explicitly stated in the user's request; never fill missing values. Output Russian or Kazakh text values matching this catalog when possible. If an entity is not in catalog, keep the original text so the server can ask clarification. Date reference today is ${today} in timezone ${TIME_ZONE}; resolve relative dates from that date only when unambiguous. If a date lacks a year and could be ambiguous, return null and ask. Date must be YYYY-MM-DD. Budget must be integer tenge; if amount is ambiguous return null and ask. Put style/quality details in preferences. Allowed cities: ${available.cities.join(' | ')}. Allowed categories: ${available.categories.join(' | ')}. Allowed event formats: ${available.formats.join(' | ')}. Allowed languages: ${available.languages.join(' | ')}. Values currently in form: ${JSON.stringify(existing)}. Your output is a proposal, do not assume the user accepts or overwrite current values.`},{role:'user',content:transcript}]})});
    const data=await response.json().catch(()=>({}));
    const content=data.choices?.[0]?.message?.content;
    if(!response.ok||typeof content!=='string') throw Object.assign(new Error('AI не смог обработать текст заявки.'),{status:502});
    let raw;try{raw=JSON.parse(content);}catch{throw Object.assign(new Error('AI вернул некорректный результат. Попробуйте уточнить запрос.'),{status:502});}
    const result=validateDraft(raw,catalog,now);
    result.overwriteFields=Object.keys(result.suggestions).filter((field)=>result.suggestions[field]!=null&&existing[field]!=null&&existing[field]!==''&&String(existing[field])!==String(result.suggestions[field]));
    result.transcript=transcript;
    return result;
  } catch(error) { if(error.name==='AbortError') throw Object.assign(new Error('AI обработка заняла слишком много времени.'),{status:504}); if(error.status) throw error; throw Object.assign(new Error('Не удалось связаться с AI-парсером.'),{status:502}); }
  finally { clearTimeout(timer); }
}

module.exports={MAX_AUDIO_BYTES,MAX_AUDIO_SECONDS,TIME_ZONE,dateInZone,options,validateDraft,transcribeAudio,parseTranscript};
