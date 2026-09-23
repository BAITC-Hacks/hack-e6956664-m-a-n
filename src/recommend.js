const { CALENDAR_RANGE } = require('./catalog');
const { cosine, evidenceLexical, lexicalScore, sentences } = require('./semantic');
const uniqueSorted = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b, 'ru'));
const dateOK = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error('AI embedding request timed out'); error.code = 'AI_TIMEOUT'; reject(error); }, timeoutMs); })]).finally(() => clearTimeout(timer));
}

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
  if (Object.hasOwn(input, 'maxHours')) errors.push('Используйте поле «durationHours» для длительности.');
  if (input.city && !catalog.some((p) => p.city === input.city)) errors.push('Выберите город из списка.');
  if (input.eventFormat && !catalog.some((p) => p.eventFormats.includes(input.eventFormat))) errors.push('Выберите формат мероприятия из списка.');
  if (input.category && !catalog.some((p) => p.categories.includes(input.category))) errors.push('Выберите категорию из каталога.');
  return errors;
}
function alternatives(catalog, req) {
  const base = catalog.filter((p) => p.city === req.city && p.categories.includes(req.category) && p.eventFormats.includes(req.eventFormat) && p.priceFromKzt <= req.budgetKzt && (!req.language || p.languages.includes(req.language)) && (req.durationHours == null || p.maxHours == null || p.maxHours >= req.durationHours));
  const freeDates = [];
  for (let day = Date.parse(`${CALENDAR_RANGE.min}T00:00:00Z`); day <= Date.parse(`${CALENDAR_RANGE.max}T00:00:00Z`); day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (date === req.date) continue;
    const count = base.filter((p) => !p.busyDates.has(date)).length;
    if (count) freeDates.push({ date, count, distance: Math.abs(day - Date.parse(`${req.date}T00:00:00Z`)) });
  }
  return freeDates.sort((a,b)=>a.distance-b.distance || a.date.localeCompare(b.date)).slice(0,3).map(({date,count})=>({date,count}));
}
function createRecommender(catalog, embeddings = null, { aiTimeoutMs = 4800 } = {}) {
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
    let ai = false; let aiFallbackReason = '';
    if (req.preferences && embeddings?.available) {
      try {
        if (!embeddings.ready && embeddings.warmupPromise) await withTimeout(embeddings.warmupPromise, aiTimeoutMs);
        if (!embeddings.ready) throw new Error('Embedding cache is not ready');
        await withTimeout(embeddings.embed([req.preferences]), aiTimeoutMs);
        ai = true;
      }
      catch (e) { aiFallbackReason = e.code === 'AI_TIMEOUT' || e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'provider_error'; console.warn('Semantic ranking unavailable; using deterministic fallback:', aiFallbackReason); }
    } else if (req.preferences) aiFallbackReason = embeddings?.available ? 'cache_not_ready' : 'not_configured';
    const scoreOf = (p) => ai ? cosine(embeddings.cache.get(req.preferences) || [], embeddings.cache.get(p.description) || []) : lexicalScore(req.preferences, p.description);
    if (req.preferences && ai) pool.sort((a,b)=>scoreOf(b)-scoreOf(a) || a.priceFromKzt-b.priceFromKzt || a.id.localeCompare(b.id,'en'));
    else pool.sort((a,b)=>a.priceFromKzt-b.priceFromKzt || a.id.localeCompare(b.id,'en'));
    const cards = pool.slice(0,3).map((p) => {
      const plainSentences = sentences(p.description);
      const evidences = req.preferences ? (ai ? plainSentences.map((s)=>({text:s,score:cosine(embeddings.cache.get(req.preferences)||[],embeddings.cache.get(s)||[])})).sort((a,b)=>b.score-a.score || a.text.localeCompare(b.text,'ru')).filter((x)=>x.score>0).slice(0,2).map((x)=>x.text) : evidenceLexical(req.preferences,p.description)) : [plainSentences.sort((a,b)=>Number(/специал|опыт|стиль|веду|провожу|предлага|услуг|работа/i.test(b))-Number(/специал|опыт|стиль|веду|провожу|предлага|услуг|работа/i.test(a)) || b.length-a.length)[0]].filter(Boolean);
      const dateLabel = new Date(`${req.date}T00:00:00Z`).toLocaleDateString('ru-RU',{day:'numeric',month:'long',timeZone:'UTC'});
      const eligibilityReasons = [`Город: ${p.city}`, `Категория: ${req.category}`, `Свободен ${dateLabel} по календарю`, `Проводит мероприятия в формате «${req.eventFormat}»`, `Цена от ${p.priceFromKzt.toLocaleString('ru-RU')} ₸ — в пределах бюджета`];
      if (req.language) eligibilityReasons.push(`В профиле указан язык «${req.language}»`);
      if (req.durationHours) eligibilityReasons.push(p.maxHours == null ? 'Максимальная длительность в профиле не указана' : `Подходит по длительности: ${req.durationHours} ч из максимальных ${p.maxHours} ч`);
      const recommendationReason = ai ? 'Профиль входит в верхнюю часть списка по semantic similarity относительно других допустимых кандидатов.' : req.preferences ? 'AI-ранжирование недоступно; профиль показан по детерминированной сортировке цена → ID.' : 'Профиль показан в порядке цены предложения.';
      return { id:p.id, name:p.name, categories:p.categories, city:p.city, priceFromKzt:p.priceFromKzt, priceImputed:p.priceImputed, cityImputed:p.cityImputed, synthetic:p.synthetic, languages:p.languages, maxHours:p.maxHours, eligibilityReasons, recommendationReason, reasons:[...eligibilityReasons,recommendationReason], evidence:evidences, semanticScore: req.preferences && ai ? Number(scoreOf(p).toFixed(6)) : undefined };
    });
    const aiNote = req.preferences && !ai ? ' AI недоступен, пожелание не использовано для ранжирования.' : '';
    const summary = pool.length < 3 ? `Обязательным условиям соответствуют ${pool.length} профилей; показаны все найденные.` : ai ? `${pool.length} профилей прошли обязательные условия. AI ранжировал только их и выбрал ${cards.length} ближайших к вашим пожеланиям.` : `Показаны ${cards.length} подходящих подрядчиков из ${pool.length}; порядок по цене предложения.`;
    return { status:200, body:{ outcome:'matched', matchedCount:pool.length, eligibleCount:pool.length, shownCount:cards.length, categoryCount:categoryPool.length, cards, rejectionCounts, funnel, aiStatus: ai ? 'active' : 'fallback', rankingMode: ai ? 'semantic' : 'price', aiFallbackReason: req.preferences && !ai ? aiFallbackReason : undefined, ranking: req.preferences ? (ai ? 'semantic' : 'fallback') : 'price', ai: ai ? 'available' : 'fallback', message: summary + aiNote, alternativeDates: alternatives(catalog,req) } };
  }
  return { meta, recommend };
}
module.exports = { createRecommender, validate };
