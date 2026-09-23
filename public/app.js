const form = document.querySelector('#search-form');
const citySelect = document.querySelector('#city');
const categorySelect = document.querySelector('#category');
const formatSelect = document.querySelector('#event-format');
const languageSelect = document.querySelector('#language');
const dateInput = document.querySelector('#date');
const resultsSection = document.querySelector('#results-section');
const statusLine = document.querySelector('#status-line');
const submitButton = document.querySelector('#submit-button');
let meta = null;

const demos = {
  dense: { city: 'Алматы', date: '2026-10-07', eventFormat: 'свадьба', category: 'Ведущий', budgetKzt: 2000000, language: '', maxHours: '' },
  'busy-date': { city: 'Алматы', date: '2026-10-03', eventFormat: 'свадьба', category: 'Ведущий', budgetKzt: 2000000, language: '', maxHours: '' },
  rare: { city: 'Алматы', date: '2026-10-07', eventFormat: 'свадьба', category: 'Инструменталист', budgetKzt: 600000, language: '', maxHours: '' },
  empty: { city: 'Алматы', date: '2026-10-07', eventFormat: 'свадьба', category: 'Ведущий', budgetKzt: 500000, language: '', maxHours: '' },
  unavailable: { city: 'Зарубежье', date: '2026-10-07', eventFormat: 'свадьба', category: 'Флорист', budgetKzt: 1500000, language: '', maxHours: '' },
};

function setOptions(select, values, selected = '') {
  select.replaceChildren(...values.map((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    return option;
  }));
  if (selected && values.includes(selected)) select.value = selected;
}

async function loadMeta(city = citySelect.value) {
  const response = await fetch(`/api/meta?city=${encodeURIComponent(city)}`);
  if (!response.ok) throw new Error('Не удалось загрузить каталог.');
  meta = await response.json();
  const currentCity = city;
  setOptions(citySelect, meta.cities, currentCity);
  setOptions(categorySelect, meta.categories, categorySelect.value);
  setOptions(formatSelect, meta.eventFormats, formatSelect.value || 'свадьба');
  setOptions(languageSelect, ['Любой язык', ...meta.languages], languageSelect.value || 'Любой язык');
  languageSelect.options[0].value = '';
  dateInput.min = meta.calendarRange.min;
  dateInput.max = meta.calendarRange.max;
  if (!dateInput.value || dateInput.value < dateInput.min || dateInput.value > dateInput.max) dateInput.value = '2026-10-07';
  document.querySelector('#catalog-count').textContent = `${meta.profileCount} профилей в каталоге`;
}

function currentRequest() {
  return {
    city: citySelect.value,
    date: dateInput.value,
    eventFormat: formatSelect.value,
    category: categorySelect.value,
    budgetKzt: Number(document.querySelector('#budget').value),
    language: languageSelect.value,
    maxHours: document.querySelector('#max-hours').value ? Number(document.querySelector('#max-hours').value) : null,
  };
}

function formatPrice(value) {
  return `${Number(value).toLocaleString('ru-RU')} ₸`;
}

function badge(text, kind = '') {
  const element = document.createElement('span');
  element.className = `badge ${kind}`.trim();
  element.textContent = text;
  return element;
}

function renderCard(card) {
  const article = document.createElement('article');
  article.className = 'vendor-card';
  const top = document.createElement('div');
  top.className = 'card-top';
  const identity = document.createElement('div');
  const category = document.createElement('div');
  category.className = 'vendor-category';
  category.textContent = card.categories.join(' · ');
  const name = document.createElement('h3');
  name.textContent = card.name;
  identity.append(category, name);
  const id = document.createElement('span');
  id.className = 'vendor-id';
  id.textContent = card.id;
  top.append(identity, id);

  const metaRow = document.createElement('div');
  metaRow.className = 'vendor-meta';
  metaRow.append(badge(card.city), badge(`от ${formatPrice(card.priceFromKzt)}`, 'badge-price'));
  if (card.synthetic) metaRow.append(badge('Синтетический профиль', 'badge-synthetic'));
  if (card.priceImputed) metaRow.append(badge('Цена оценочная', 'badge-imputed'));
  if (card.cityImputed) metaRow.append(badge('Город восстановлен', 'badge-imputed'));

  const explanation = document.createElement('div');
  explanation.className = 'explanation';
  const list = document.createElement('ul');
  for (const reason of card.reasons) {
    const item = document.createElement('li');
    item.textContent = reason;
    list.append(item);
  }
  explanation.append(list);
  article.append(top, metaRow, explanation);
  return article;
}

async function submitSearch() {
  statusLine.textContent = '';
  submitButton.disabled = true;
  submitButton.querySelector('span:first-child').textContent = 'Подбираем…';
  try {
    const response = await fetch('/api/recommendations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentRequest()),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Не удалось выполнить подбор.');
    document.querySelector('#results-title').textContent = data.outcome === 'matched'
      ? 'Ваши варианты'
      : data.outcome === 'category_unavailable' ? 'Категория недоступна' : 'Подходящих вариантов нет';
    document.querySelector('#result-count').textContent = data.outcome === 'matched'
      ? `Показано ${data.shownCount} из ${data.matchedCount}`
      : '0 вариантов';
    document.querySelector('#result-message').textContent = data.message;
    const cards = document.querySelector('#cards');
    cards.replaceChildren(...data.cards.map(renderCard));
    resultsSection.hidden = false;
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    statusLine.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.querySelector('span:first-child').textContent = 'Подобрать подрядчиков';
  }
}

citySelect.addEventListener('change', async () => {
  try { await loadMeta(citySelect.value); }
  catch (error) { statusLine.textContent = error.message; }
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitSearch();
});

document.querySelectorAll('[data-demo]').forEach((button) => {
  button.addEventListener('click', async () => {
    const preset = demos[button.dataset.demo];
    await loadMeta(preset.city);
    for (const key of ['city', 'date', 'eventFormat', 'category', 'budgetKzt', 'language', 'maxHours']) {
      const field = form.elements.namedItem(key);
      if (field) field.value = preset[key];
    }
    await submitSearch();
  });
});

loadMeta().catch((error) => { statusLine.textContent = error.message; });
