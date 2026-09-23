const { CALENDAR_RANGE } = require('./catalog');
const { cosine, evidenceLexical, lexicalScore, sentences } = require('./semantic');
const uniqueSorted = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b, 'ru'));
const dateOK = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function validate(input, catalog) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['Тело запроса должно быть JSON-объектом.'];
  for (const key of ['city', 'date', 'eventFormat', 'category']) if (typeof input[key] !== 'string' || !input[key].trim()) errors.push(`Поле «${key}» обязательно.`);
  if (!Number.isInteger(input.budgetKzt) || input.budgetKzt < 0) errors.push('Бюджет должен быть целым числом не меньше нуля.');
  if (!dateOK(input.date)) errors.push('Укажите корректную дату в формате ГГГГ-ММ-ДД.');
  else if (input.date < CALENDAR_RANGE.min || input.date > CALENDAR_RANGE.max) errors.push(`Дата должна быть между ${CALENDAR_RANGE.min} и ${CALENDAR_RANGE.max}.`);
  if (input.language && !catalog.some((p) => p.languages.includes(input.language))) errors.push('Выберите язык из списка.');
  if (input.durationHours != null && input.durationHours !== '' && (!Number.isFinite(Number(input.durationHours)) || Number(input.durationHours) <= 0 || Number(input.durationHours) > 24)) errors.push('Длительность должна быть числом от 1 до 24 часов.');
  if (input.preferences != null && (typeof input.preferences !== 'string' || input.preferences.length > 500)) errors.push('Пожелания должны быть текстом длиной до 500 символов.');
  if (input.city && !catalog.some((p) => p.city === input.city)) errors.push('Выберите город из списка.');
  if (input.eventFormat && !catalog.some((p) => p.eventFormats.includes(input.eventFormat))) errors.push('Выберите формат мероприятия из списка.');
  if (input.category && !catalog.some((p) => p.categories.includes(input.category))) errors.push('Выберите категорию из каталога.');
  return errors;
}
function alternatives(catalog, req) {
  const base = catalog.filter((p) => p.city === req.city && p.categories.includes(req.category) && p.eventFormats.includes(req.eventFormat) && p.priceFromKzt <= req.budgetKzt && (!req.language || p.languages.includes(req.language)) && (req.durationHours == null || p.maxHours == null || p.maxHours >= req.durationHours));
  const dates = [...new Set(base.filter((p) => !p.busyDates.has(req.date)).map((p) => p.id))];
  const freeDates = new Map();
  for (const p of base) for (const d of p.busyDates) if (d >= CALENDAR_RANGE.min && d <= CALENDAR_RANGE.max && d !== req.date) freeDates.set(d, (freeDates.get(d) || 0) + 1);
  return [...freeDates].filter(([, count]) => count).sort((a, b) => Math.abs(Date.parse(a[0]) - Date.parse(req.date)) - Math.abs(Date.parse(b[0]) - Date.parse(req.date)) || a[0].localeCompare(b[0])).slice(0, 3).map(([date, count]) => ({ date, count }));
}
function createRecommender(catalog, embeddings = null) {
  const cities = uniqueSorted(catalog.map((p) => p.city));
  const meta = (city = cities[0]) => ({ cities, categories: uniqueSorted(catalog.flatMap((p) => p.categories)), categoriesInCity: uniqueSorted(catalog.filter((p) => p.city === city).flatMap((p) => p.categories)), eventFormats: uniqueSorted(catalog.flatMap((p) => p.eventFormats)), languages: uniqueSorted(catalog.flatMap((p) => p.languages)), calendarRange: CALENDAR_RANGE, profileCount: catalog.length });
  async function recommend(input) {
    const errors = validate(input, catalog);
    if (errors.length) return { status: 400, body: { error: 'invalid_request', message: errors.join(' ') } };
    const req = { city: input.city.trim(), date: input.date, eventFormat: input.eventFormat.trim(), category: input.category.trim(), budgetKzt: input.budgetKzt, language: input.language || '', durationHours: input.durationHours == null || input.durationHours === '' ? null : Number(input.durationHours), preferences: (input.preferences || '').trim() };
    const categoryPool = catalog.filter((p) => p.city === req.city && p.categories.includes(req.category));
    if (!categoryPool.length) return { status: 200, body: { outcome: 'category_unavailable', matchedCount: 0, shownCount: 0, categoryCount: 0, cards: [], message: `В городе «${req.city}» нет подрядчиков категории «${req.category}».`, rejectionCounts: {}, funnel: [] } };
    let pool = categoryPool; const rejectionCounts = {}; const funnel = [{ stage: 'Город и категория', input: catalog.filter((p) => p.city === req.city).length, passed: categoryPool.length, excluded: catalog.filter((p) => p.city === req.city).length - categoryPool.length }];
    const filter = (key, label, predicate) => { const before = pool.length; pool = pool.filter(predicate); rejectionCounts[key] = before - pool.length; funnel.push({ stage: label, input: before, passed: pool.length, excluded: before - pool.length }); };
    filter('eventFormat', 'Формат', (p) => p.eventFormats.includes(req.eventFormat));
    filter('busyOnDate', 'Занятость на дату', (p) => !p.busyDates.has(req.date));
    filter('overBudget', 'Бюджет', (p) => p.priceFromKzt <= req.budgetKzt);
    if (req.language) filter('language', 'Язык', (p) => p.languages.includes(req.language));
    if (req.durationHours) filter('duration', 'Длительность', (p) => p.maxHours == null || p.maxHours >= req.durationHours);
    if (!pool.length) {
      const labels = { busyOnDate: 'заняты на эту дату', overBudget: 'дороже указанного бюджета', eventFormat: 'не берут этот формат', language: 'не работают на выбранном языке', duration: 'не подходят по длительности' };
      const reasons = Object.entries(rejectionCounts).filter(([,n]) => n).map(([k,n]) => `${n} ${labels[k]}`);
      const budgetGuide = categoryPool.filter((p) => p.eventFormats.includes(req.eventFormat) && !p.busyDates.has(req.date) && (!req.language || p.languages.includes(req.language)) && (req.durationHours == null || p.maxHours == null || p.maxHours >= req.durationHours)).map((p) => p.priceFromKzt).sort((a,b)=>a-b)[0];
      const altDates = alternatives(catalog, req);
      return { status: 200, body: { outcome: 'no_eligible_candidates', matchedCount: 0, shownCount: 0, categoryCount: categoryPool.length, cards: [], rejectionCounts, funnel, budgetGuideKzt: budgetGuide || null, alternativeDates: altDates, message: `В городе есть ${categoryPool.length} профилей категории «${req.category}», но никто не прошёл фильтры: ${reasons.join('; ')}.` } };
    }
    let ai = false; let vectors = new Map();
    if (req.preferences && embeddings) { try { const all = await embeddings.embed([req.preferences, ...pool.flatMap((p) => sentences(p.description))]); vectors = new Map(all.slice(1).map((v,i) => [sentences(pool.flatMap((p)=>sentences(p.description))[i] || '')[0], v])); ai = true; } catch (e) { console.warn('Semantic ranking unavailable; using deterministic fallback:', e.message); } }
    const scoreOf = (p) => ai ? Math.max(0, ...sentences(p.description).map((s) => cosine(embeddings.cache.get(req.preferences) || [], embeddings.cache.get(s) || []))) : lexicalScore(req.preferences, p.description);
    if (req.preferences && ai) pool.sort((a,b)=>scoreOf(b)-scoreOf(a) || a.priceFromKzt-b.priceFromKzt || a.id.localeCompare(b.id,'en'));
    else pool.sort((a,b)=>a.priceFromKzt-b.priceFromKzt || a.id.localeCompare(b.id,'en'));
    const cards = pool.slice(0,3).map((p) => {
      const evidences = req.preferences ? (ai ? sentences(p.description).map((s)=>({text:s,score:cosine(embeddings.cache.get(req.preferences)||[],embeddings.cache.get(s)||[])})).sort((a,b)=>b.score-a.score).filter((x)=>x.score>0).slice(0,2).map((x)=>x.text) : evidenceLexical(req.preferences,p.description)) : sentences(p.description).slice(0,1);
      const reasons = [`Совпадает с обязательными условиями: город, формат «${req.eventFormat}», свободная дата и цена от ${p.priceFromKzt.toLocaleString('ru-RU')} ₸ в пределах бюджета.`];
      if (req.language) reasons.push(`В профиле указан язык «${req.language}».`);
      if (req.durationHours && p.maxHours != null) reasons.push(`Заявленная длительность ${req.durationHours} ч при максимуме ${p.maxHours} ч.`);
      return { id:p.id, name:p.name, categories:p.categories, city:p.city, priceFromKzt:p.priceFromKzt, priceImputed:p.priceImputed, cityImputed:p.cityImputed, synthetic:p.synthetic, languages:p.languages, maxHours:p.maxHours, reasons, evidence:evidences, semanticScore: req.preferences && ai ? Number(scoreOf(p).toFixed(4)) : undefined };
    });
    return { status:200, body:{ outcome:'matched', matchedCount:pool.length, shownCount:cards.length, categoryCount:categoryPool.length, cards, rejectionCounts, funnel, ranking: req.preferences ? (ai ? 'semantic' : 'fallback') : 'price', ai: ai ? 'available' : 'fallback', message: pool.length < 3 ? `Условиям соответствуют ${pool.length} профилей; показаны все найденные.` : `Подходящих подрядчиков: ${pool.length}. Показаны первые ${cards.length}${ai ? ' по соответствию пожеланиям' : ' по цене предложения'}.`, alternativeDates: alternatives(catalog,req) } };
  }
  return { meta, recommend };
}
module.exports = { createRecommender, validate };
