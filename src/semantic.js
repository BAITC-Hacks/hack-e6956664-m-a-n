const STOP = new Set('и в на с по для или от до как это что мы я он она они их его её не без при из к а но'.split(' '));

function tokens(text) {
  return (String(text || '').toLocaleLowerCase('ru').match(/[\p{L}\p{N}]+/gu) || []).filter((x) => x.length > 2 && !STOP.has(x));
}
function sentences(text) { return String(text || '').split(/(?:\r?\n)+|(?<=[.!?;])\s+|(?=[•·])/).map((s) => s.trim().replace(/^[•·]\s*/, '').trim()).filter(Boolean); }
function cosine(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0;
    dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
function evidenceLexical(query, description) {
  const q = new Set(tokens(query));
  return sentences(description).map((text) => ({ text, score: tokens(text).filter((t) => q.has(t)).length / Math.max(q.size, 1) }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.text.localeCompare(b.text, 'ru')).slice(0, 2).map((x) => x.text);
}
function lexicalScore(query, description) {
  const q = new Set(tokens(query)); const d = new Set(tokens(description));
  return q.size ? [...q].filter((x) => d.has(x)).length / Math.sqrt(q.size * Math.max(1, d.size)) : 0;
}

class OpenAIEmbeddings {
  constructor({ apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY, provider = process.env.AI_PROVIDER || 'openai', model = process.env.AI_MODEL || process.env.EMBEDDING_MODEL || 'text-embedding-3-small', timeoutMs = Number(process.env.AI_TIMEOUT_MS || 4500), fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.provider = provider.toLowerCase();
    this.model = model;
    this.timeoutMs = Math.min(Math.max(timeoutMs, 250), 10000);
    this.fetch = fetchImpl;
    this.cache = new Map();
    this.ready = false;
    this.warmupPromise = null;
    this.lastError = '';
  }
  get available() { return this.provider === 'openai' && Boolean(this.apiKey); }

  async embed(texts) {
    if (!this.available) throw new Error('Embedding provider is not configured');
    const uniqueMissing = [...new Set(texts)].filter((text) => !this.cache.has(text));
    for (let i = 0; i < uniqueMissing.length; i += 512) {
      const batch = uniqueMissing.slice(i, i + 512);
      const response = await this.fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: batch }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}`);
      const json = await response.json();
      if (!Array.isArray(json?.data) || json.data.length !== batch.length) throw new Error('Malformed embedding response: unexpected vector count');
      const seen = new Set();
      for (const item of json.data) {
        if (!Number.isInteger(item.index) || item.index < 0 || item.index >= batch.length || seen.has(item.index) || !Array.isArray(item.embedding) || !item.embedding.length || !item.embedding.every(Number.isFinite)) throw new Error('Malformed embedding response: invalid vector');
        seen.add(item.index);
        this.cache.set(batch[item.index], item.embedding);
      }
      if (seen.size !== batch.length) throw new Error('Malformed embedding response: incomplete vector batch');
    }
    return texts.map((text) => this.cache.get(text));
  }

  preload(profiles) {
    if (this.warmupPromise) return this.warmupPromise;
    if (!this.available) return Promise.resolve(false);
    const texts = profiles.flatMap((profile) => [profile.description, ...sentences(profile.description)]).filter(Boolean);
    this.warmupPromise = this.embed(texts).then(() => {
      this.ready = true;
      this.lastError = '';
      return true;
    }).catch((error) => {
      this.ready = false;
      this.lastError = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : error.message;
      throw error;
    });
    return this.warmupPromise;
  }
}

module.exports = { OpenAIEmbeddings, cosine, evidenceLexical, lexicalScore, sentences, tokens };
