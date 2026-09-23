const $ = (selector) => document.querySelector(selector);
const form = $('#search-form');
const statusLine = $('#status-line');
let meta;
let latestCards = [];
const selected = new Set();

const demos = {
  dense: { city:'Алматы', date:'2026-10-07', eventFormat:'свадьба', category:'Ведущий', budgetKzt:2000000 },
  busy: { city:'Алматы', date:'2026-10-03', eventFormat:'свадьба', category:'Ведущий', budgetKzt:2000000 },
  rare: { city:'Алматы', date:'2026-10-07', eventFormat:'свадьба', category:'Инструменталист', budgetKzt:600000 },
  empty: { city:'Алматы', date:'2026-10-07', eventFormat:'свадьба', category:'Ведущий', budgetKzt:500000 },
  unavailable: { city:'Зарубежье', date:'2026-10-07', eventFormat:'свадьба', category:'Флорист', budgetKzt:1500000 },
  ai: { city:'Алматы', date:'2026-10-15', eventFormat:'корпоратив', category:'Ведущий', budgetKzt:1500000, language:'русский', durationHours:6, preferences:'Интеллигентный ведущий с опытом бизнес-мероприятий, без навязчивого юмора' },
};

function setOptions(select, values, value) {
  select.replaceChildren(...values.map((item) => new Option(item, item)));
  if (value && values.includes(value)) select.value = value;
}
async function loadMeta(city = $('#city').value) {
  const response = await fetch(`/api/meta?city=${encodeURIComponent(city)}`);
  if (!response.ok) throw new Error('Не удалось загрузить каталог.');
  meta = await response.json();
  setOptions($('#city'), meta.cities, city);
  setOptions($('#category'), meta.categoriesInCity, $('#category').value);
  setOptions($('#event-format'), meta.eventFormats, $('#event-format').value || 'свадьба');
  setOptions($('#language'), ['Любой язык', ...meta.languages], $('#language').value || 'Любой язык');
  $('#language').options[0].value = '';
  $('#date').min = meta.calendarRange.min;
  $('#date').max = meta.calendarRange.max;
  if (!$('#date').value || $('#date').value > $('#date').max || $('#date').value < $('#date').min) $('#date').value = '2026-10-07';
  $('#catalog-count').textContent = `${meta.profileCount} профилей в каталоге`;
}
$('#city').addEventListener('change', () => loadMeta($('#city').value).catch((error) => { statusLine.textContent = error.message; }));

function currentRequest() {
  return {
    city: $('#city').value, date: $('#date').value, eventFormat: $('#event-format').value,
    category: $('#category').value, budgetKzt: Number($('#budget').value), language: $('#language').value,
    durationHours: $('#duration-hours').value ? Number($('#duration-hours').value) : null,
    preferences: $('#preferences').value.trim(),
  };
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function render(data) {
  $('#results-section').hidden = false;
  $('#result-message').textContent = data.message;
  $('#result-count').textContent = `${data.matchedCount} найдено · ${data.shownCount} показано`;
  const selectionText = $('#selection-summary-text');
  if (data.aiStatus === 'active' && currentRequest().preferences) {
    selectionText.textContent = `${data.eligibleCount} подрядчиков прошли обязательные условия. Semantic AI сравнил пожелания только с этими профилями и выбрал ${data.shownCount} наиболее близких. Календарь и бюджет проверил обычный код.`;
  } else if (currentRequest().preferences) {
    selectionText.textContent = `${data.eligibleCount || 0} подрядчиков прошли обязательные условия. AI-ранжирование сейчас недоступно; порядок детерминированный — цена, затем ID.`;
  } else {
    selectionText.textContent = `${data.eligibleCount ?? data.matchedCount} подрядчиков прошли обязательные условия. Без пожелания варианты идут по возрастанию цены, затем ID.`;
  }

  const funnel = $('#funnel');
  funnel.replaceChildren();
  if (data.funnel?.length) {
    funnel.append(node('h3', '', 'Как прошли фильтры'));
    const row = node('div', 'funnel-row');
    for (const stage of data.funnel) {
      const step = node('div', 'funnel-step');
      step.append(node('b', '', String(stage.passed)), node('span', '', stage.stage), node('small', '', `${stage.excluded} исключено`));
      row.append(step);
    }
    funnel.append(row);
  }

  const cards = $('#cards');
  cards.replaceChildren();
  $('#comparison').replaceChildren();
  $('#comparison').hidden = true;
  $('#alternatives').replaceChildren();
  latestCards = data.cards || [];
  selected.clear();
  for (const contractor of latestCards) {
    const card = node('article', 'vendor-card');
    const top = node('div', 'card-top');
    top.append(node('div', '', contractor.categories.join(' · ')), node('small', '', contractor.id));
    card.append(top, node('h3', '', contractor.name), node('p', 'price', `от ${contractor.priceFromKzt.toLocaleString('ru-RU')} ₸`));
    const badges = node('div', 'badges');
    for (const [flag, label] of [[contractor.synthetic, 'Синтетический профиль'], [contractor.priceImputed, 'Цена оценочная'], [contractor.cityImputed, 'Город восстановлен']]) if (flag) badges.append(node('span', 'badge', label));
    card.append(badges);

    const eligibility = node('ul', 'reasons');
    for (const reason of contractor.eligibilityReasons || contractor.reasons || []) eligibility.append(node('li', '', reason));
    card.append(eligibility);
    if (contractor.recommendationReason) card.append(node('p', 'recommendation-reason', contractor.recommendationReason));
    if (contractor.evidence?.length) {
      card.append(node('h4', '', currentRequest().preferences ? 'Доказательства из профиля' : 'Из описания профиля'));
      const quote = node('blockquote', 'evidence');
      for (const text of contractor.evidence) quote.append(node('p', '', `«${text}»`));
      card.append(quote);
    }
    if (contractor.semanticScore !== undefined) card.append(node('small', 'score', `Cosine similarity: ${contractor.semanticScore.toFixed(4)} · только для диагностики`));

    const compare = node('label', 'compare');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => { checkbox.checked ? selected.add(contractor.id) : selected.delete(contractor.id); drawCompare(); });
    compare.append(checkbox, document.createTextNode(' Сравнить'));
    card.append(compare);
    const feedback = node('div', 'feedback');
    for (const label of ['👍 Подходит', '👎 Не подходит']) {
      const button = node('button', 'small-button', label);
      button.type = 'button';
      button.addEventListener('click', () => { button.textContent = 'Спасибо за отзыв'; });
      feedback.append(button);
    }
    card.append(feedback);
    cards.append(card);
  }
  if (data.budgetGuideKzt) $('#alternatives').append(node('p', '', `При остальных выбранных условиях минимальная цена в каталоге: от ${data.budgetGuideKzt.toLocaleString('ru-RU')} ₸.`));
  if (data.alternativeDates?.length) {
    const text = data.alternativeDates.map((item) => `${item.date} (${item.count})`).join(' · ');
    $('#alternatives').append(node('p', '', `Ближайшие даты с доступными профилями: ${text}`));
  }
}
function drawCompare() {
  const box = $('#comparison');
  const items = latestCards.filter((contractor) => selected.has(contractor.id));
  if (items.length < 2) { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren(node('h3', '', 'Сравнение выбранных профилей'));
  const table = document.createElement('table');
  for (const [label, key] of [['Подрядчик', 'name'], ['Цена от', 'priceFromKzt'], ['Языки', 'languages'], ['Категории', 'categories'], ['Условия', 'eligibilityReasons'], ['Почему рекомендован', 'recommendationReason'], ['Доказательства из профиля', 'evidence']]) {
    const row = document.createElement('tr');
    row.append(node('th', '', label));
    for (const contractor of items) {
      const cell = document.createElement('td');
      const value = contractor[key];
      cell.textContent = Array.isArray(value) ? value.join(' · ') : key === 'priceFromKzt' ? `от ${value.toLocaleString('ru-RU')} ₸` : value || '';
      row.append(cell);
    }
    table.append(row);
  }
  box.append(table);
}
async function submitSearch() {
  statusLine.textContent = '';
  $('#submit-button').disabled = true;
  try {
    const response = await fetch('/api/recommendations', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(currentRequest()) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Не удалось выполнить подбор.');
    render(data);
    $('#results-section').scrollIntoView({ behavior:'smooth', block:'start' });
  } catch (error) { statusLine.textContent = error.message; }
  finally { $('#submit-button').disabled = false; }
}

form.addEventListener('submit', (event) => { event.preventDefault(); submitSearch(); });
document.querySelectorAll('[data-demo]').forEach((button) => button.addEventListener('click', async () => {
  const demo = demos[button.dataset.demo];
  for (const [key, value] of Object.entries(demo)) {
    const selector = { eventFormat:'#event-format', budgetKzt:'#budget', durationHours:'#duration-hours' }[key] || `#${key}`;
    const input = $(selector);
    if (input) input.value = value;
  }
  if (!Object.hasOwn(demo, 'language')) $('#language').value = '';
  if (!Object.hasOwn(demo, 'durationHours')) $('#duration-hours').value = '';
  if (!Object.hasOwn(demo, 'preferences')) $('#preferences').value = '';
  await submitSearch();
}));
loadMeta().catch((error) => { statusLine.textContent = error.message; });
