const fs=require('node:fs');
const path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
try{for(const line of fs.readFileSync(path.join(ROOT,'.env'),'utf8').split(/\r?\n/)){const match=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(match&&!process.env[match[1]])process.env[match[1]]=match[2].replace(/^['"]|['"]$/g,'');}}catch{}
const {loadCatalog}=require('../src/catalog');
const {OpenAIEmbeddings}=require('../src/semantic');
const {parseTranscript}=require('../src/voice');
async function main(){
 const embeddings=new OpenAIEmbeddings();if(!embeddings.available)throw new Error('AI_API_KEY / OPENAI_API_KEY не настроен.');
 const vectors=await embeddings.embed(['Проверка конфигурации embedding provider']);
 const voice=await parseTranscript('Нужен ведущий в Алматы на корпоратив 15 октября 2026 года, бюджет 1500000 тенге, русский язык, шесть часов, спокойный стиль.',loadCatalog(),{});
 console.log(JSON.stringify({status:'passed',embeddingDimensions:vectors[0].length,voiceSuggestions:voice.suggestions,clarifications:voice.clarifications},null,2));
}
main().catch(()=>{console.error('Проверка AI не прошла. Проверьте ключ, доступ сети к API и имена моделей; секреты не выводятся.');process.exitCode=1;});
