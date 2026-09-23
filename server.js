const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'contractors.csv');
const PORT = Number(process.env.PORT || 3000);

function parseCsv(source) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value !== '')) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift().map((header) => header.replace(/^\uFEFF/, '').trim());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function splitList(value) {
  return value ? value.split('|').map((item) => item.trim()).filter(Boolean) : [];
}

function toProfile(row) {
  return {
    id: row.id,
    name: row.anon_name,
    categories: splitList(row.categories),
    city: row.city,
    cityImputed: row.city_imputed.toLowerCase() === 'true',
    synthetic: row.synthetic.toLowerCase() === 'true',
    priceFromKzt: Number(row.price_from_kzt),
    priceImputed: row.price_imputed.toLowerCase() === 'true',
    eventFormats: splitList(row.event_formats),
    languages: splitList(row.languages),
    maxHours: row.max_hours === '' ? null : Number(row.max_hours),
    busyDates: new Set(splitList(row.busy_dates)),
    description: row.description,
  };
}

function loadCatalog() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const catalog = parseCsv(raw).map(toProfile);
  if (catalog.length !== 66) {
    console.warn(`Ожидалось 66 профилей, загружено ${catalog.length}.`);
  }
  return catalog;
}

const catalog = loadCatalog();
const cities = [...new Set(catalog.map((profile) => profile.city))].sort((a, b) => a.localeCompare(b, 'ru'));
const categories = [...new Set(catalog.flatMap((profile) => profile.categories))].sort((a, b) => a.localeCompare(b, 'ru'));
const eventFormats = [...new Set(catalog.flatMap((profile) => profile.eventFormats))].sort((a, b) => a.localeCompare(b, 'ru'));
const languages = [...new Set(catalog.flatMap((profile) => profile.languages))].sort((a, b) => a.localeCompare(b, 'ru'));
const dateValues = catalog.flatMap((profile) => [...profile.busyDates]);
const calendarRange = { min: dateValues.sort()[0], max: [...dateValues].sort().at(-1) };

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function excerpt(description) {
  const candidates = (description || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/^[\s•·\-–]+/, '').trim())
    .filter((sentence) => sentence.length >= 35);
  const specific = candidates.find((sentence) =>
    /специализ|предлага|работаем|работаю|выполня|оформлен|съ[её]мк|репертуар|вместимост|под ключ|сценари|выездн|собираем|производств|изготовл|аренд|услуг|опыт|проводим|созда[её]м|организ/i.test(sentence),
  );
  const chosen = specific || candidates[0] || (description || '').replace(/\s+/g, ' ').trim();
  if (!chosen) return '';
  return chosen.length > 180 ? `${chosen.slice(0, 177).trimEnd()}…` : chosen;
}

function validateRequest(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['Тело запроса должно быть JSON-объектом.'];
  }
  const required = ['city', 'date', 'eventFormat', 'category'];
  for (const key of required) {
    if (typeof input[key] !== 'string' || !input[key].trim()) errors.push(`Поле «${key}» обязательно.`);
  }
  if (!Number.isInteger(input.budgetKzt) || input.budgetKzt < 0) errors.push('Бюджет должен быть целым числом не меньше нуля.');
  if (!validDate(input.date)) errors.push('Укажите корректную дату в формате ГГГГ-ММ-ДД.');
  else if (input.date < calendarRange.min || input.date > calendarRange.max) errors.push(`Дата должна быть между ${calendarRange.min} и ${calendarRange.max}.`);
  if (input.language != null && input.language !== '' && !languages.includes(input.language)) errors.push('Выберите язык из списка.');
  if (input.maxHours != null && input.maxHours !== '' && (!Number.isFinite(input.maxHours) || input.maxHours <= 0 || input.maxHours > 24)) errors.push('Длительность должна быть числом от 1 до 24 часов.');
  if (input.city && !cities.includes(input.city)) errors.push('Выберите город из списка.');
  if (input.eventFormat && !eventFormats.includes(input.eventFormat)) errors.push('Выберите формат мероприятия из списка.');
  if (input.category && !catalog.some((profile) => profile.categories.includes(input.category))) errors.push('Выберите категорию из каталога.');
  return errors;
}

function explain(profile, request) {
  const dateLabel = new Date(`${request.date}T00:00:00Z`).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', timeZone: 'UTC',
  });
  const price = profile.priceFromKzt.toLocaleString('ru-RU');
  const priceReason = profile.priceFromKzt === request.budgetKzt
    ? `цена от ${price} ₸ совпадает с бюджетом`
    : `цена от ${price} ₸ на ${(request.budgetKzt - profile.priceFromKzt).toLocaleString('ru-RU')} ₸ ниже бюджета`;
  const facts = [`Берёт формат «${request.eventFormat}»`, `свободен ${dateLabel} по календарю`, priceReason];
  if (request.language) facts.push(`в профиле указан язык «${request.language}»`);
  if (request.maxHours && profile.maxHours != null) facts.push(`подходит по длительности (${request.maxHours} ч из максимальных ${profile.maxHours} ч)`);
  const highlight = excerpt(profile.description);
  const details = [`${facts.join('; ')}.`];
  if (highlight) details.push(`В описании: «${highlight}».`);
  return details;
}

function recommend(input) {
  const errors = validateRequest(input);
  if (errors.length) return { status: 400, body: { error: 'invalid_request', message: errors.join(' ') } };

  const request = {
    city: input.city.trim(),
    date: input.date,
    eventFormat: input.eventFormat.trim(),
    category: input.category.trim(),
    budgetKzt: input.budgetKzt,
    language: input.language || '',
    maxHours: input.maxHours == null || input.maxHours === '' ? null : Number(input.maxHours),
  };
  const categoryPool = catalog.filter((profile) => profile.city === request.city && profile.categories.includes(request.category));
  if (!categoryPool.length) {
    return { status: 200, body: {
      outcome: 'category_unavailable', matchedCount: 0, shownCount: 0, categoryCount: 0, cards: [],
      message: `В городе «${request.city}» нет подрядчиков категории «${request.category}».`,
      rejectionCounts: {},
    } };
  }

  let pool = categoryPool;
  const rejectionCounts = {};
  const filter = (key, predicate) => {
    const passed = pool.filter(predicate);
    rejectionCounts[key] = pool.length - passed.length;
    pool = passed;
  };
  filter('eventFormat', (profile) => profile.eventFormats.includes(request.eventFormat));
  filter('busyOnDate', (profile) => !profile.busyDates.has(request.date));
  filter('overBudget', (profile) => profile.priceFromKzt <= request.budgetKzt);
  if (request.language) filter('language', (profile) => profile.languages.includes(request.language));
  if (request.maxHours) filter('duration', (profile) => profile.maxHours == null || profile.maxHours >= request.maxHours);

  const rejected = Object.entries(rejectionCounts).filter(([, count]) => count > 0);
  if (!pool.length) {
    const labels = {
      busyOnDate: 'заняты на эту дату',
      overBudget: 'дороже указанного бюджета',
      eventFormat: 'не берут этот формат',
      language: 'не работают на выбранном языке',
      duration: 'не подходят по длительности',
    };
    const reasons = rejected.map(([key, count]) => `${count} ${labels[key]}`);
    return { status: 200, body: {
      outcome: 'no_eligible_candidates', matchedCount: 0, shownCount: 0,
      categoryCount: categoryPool.length, cards: [], rejectionCounts,
      message: `В городе есть ${categoryPool.length} ${categoryPool.length === 1 ? 'подрядчик' : 'подрядчика'} категории «${request.category}», но никто не подошёл: ${reasons.join('; ')}.`,
    } };
  }

  pool.sort((a, b) => a.priceFromKzt - b.priceFromKzt || a.id.localeCompare(b.id, 'en'));
  const cards = pool.slice(0, 3).map((profile) => ({
    id: profile.id,
    name: profile.name,
    categories: profile.categories,
    city: profile.city,
    priceFromKzt: profile.priceFromKzt,
    priceImputed: profile.priceImputed,
    cityImputed: profile.cityImputed,
    synthetic: profile.synthetic,
    languages: profile.languages,
    maxHours: profile.maxHours,
    reasons: explain(profile, request),
  }));
  const exclusionLabels = {
    busyOnDate: 'заняты на выбранную дату',
    overBudget: 'превышают бюджет',
    eventFormat: 'не берут этот формат',
    language: 'не соответствуют языку',
    duration: 'не подходят по длительности',
  };
  const exclusionSummary = Object.entries(rejectionCounts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${exclusionLabels[key]}`)
    .join(', ');
  const message = pool.length < 3
    ? `В городе есть профили этой категории: ${categoryPool.length}. Условиям соответствуют: ${pool.length}${exclusionSummary ? `. Исключены: ${exclusionSummary}` : ''}.`
    : `Подходящих подрядчиков: ${pool.length}. Показаны первые ${cards.length} по цене предложения.`;
  return { status: 200, body: {
    outcome: 'matched', matchedCount: pool.length, shownCount: cards.length,
    categoryCount: categoryPool.length, cards, message, rejectionCounts,
  } };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 20_000) {
        reject(new Error('Запрос слишком большой.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('Тело запроса должно быть JSON.')); }
    });
    request.on('error', reject);
  });
}

const publicDir = path.join(ROOT, 'public');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/api/meta') {
    const city = url.searchParams.get('city') || cities[0];
    const cityCatalog = catalog.filter((profile) => profile.city === city);
    return sendJson(response, 200, {
      cities,
      categories,
      categoriesInCity: [...new Set(cityCatalog.flatMap((profile) => profile.categories))].sort((a, b) => a.localeCompare(b, 'ru')),
      eventFormats,
      languages,
      calendarRange,
      profileCount: catalog.length,
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/recommendations') {
    try {
      const input = await readBody(request);
      const result = recommend(input);
      return sendJson(response, result.status, result.body);
    } catch (error) {
      return sendJson(response, 400, { error: 'bad_request', message: error.message });
    }
  }
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/styles.css' || url.pathname === '/app.js')) {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = path.join(publicDir, file);
    if (!fs.existsSync(filePath)) return sendJson(response, 404, { error: 'not_found' });
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)], 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(filePath).pipe(response);
  }
  return sendJson(response, 404, { error: 'not_found', message: 'Маршрут не найден.' });
});

server.listen(PORT, () => {
  console.log(`HackAlem AI запущен: http://localhost:${PORT} (профилей: ${catalog.length})`);
});
