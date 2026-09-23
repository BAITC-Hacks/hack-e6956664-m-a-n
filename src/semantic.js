const STOP = new Set('и в на с по для или от до как это что мы я он она они их его её не без при из к а но'.split(' '));
function tokens(text) {
  return (String(text || '').toLocaleLowerCase('ru').match(/[\p{L}\p{N}]+/gu) || []).filter((x) => x.length > 2 && !STOP.has(x));
}
function sentences(text) { return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean); }
function cosine(a, b) { let dot = 0, aa = 0, bb = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 1) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; } return aa && bb ? dot / Math.sqrt(aa * bb) : 0; }
function evidenceLexical(query, description) {
  const q = new Set(tokens(query));
  return sentences(description).map((sentence) => ({ text: sentence, score: tokens(sentence).filter((t) => q.has(t)).length / Math.max(q.size, 1) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.text.localeCompare(b.text, 'ru')).slice(0, 2).map((x) => x.text);
}
function lexicalScore(query, description) {
  const q = new Set(tokens(query)); const d = new Set(tokens(description));
  return q.size ? [...q].filter((x) => d.has(x)).length / Math.sqrt(q.size * Math.max(1, d.size)) : 0;
}
class OpenAIEmbeddings {
  constructor({ apiKey = process.env.OPENAI_API_KEY, model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small' } = {}) { this.apiKey = apiKey; this.model = model; this.cache = new Map(); }
  get available() { return Boolean(this.apiKey); }
  async embed(texts) {
    if (!this.available) throw new Error('Embeddings provider is not configured');
    const missing = [...new Set(texts)].filter((t) => !this.cache.has(t));
    for (let i = 0; i < missing.length; i += 64) {
      const batch = missing.slice(i, i + 64);
      const response = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.model, input: batch }) });
      if (!response.ok) throw new Error(`Embedding service returned ${response.status}`);
      const json = await response.json();
      json.data.forEach((item) => this.cache.set(batch[item.index], item.embedding));
    }
    return texts.map((t) => this.cache.get(t));
  }
}
module.exports = { OpenAIEmbeddings, cosine, evidenceLexical, lexicalScore, sentences, tokens };
