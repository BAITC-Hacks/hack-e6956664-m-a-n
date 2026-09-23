const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, loadCatalog } = require('./src/catalog');
const { createRecommender } = require('./src/recommend');
const { OpenAIEmbeddings } = require('./src/semantic');

// Optional local .env support; production hosts should use their environment settings.
try { for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); } } catch {}
const catalog = loadCatalog();
const embeddings = new OpenAIEmbeddings();
const engine = createRecommender(catalog, embeddings);
const cacheWarmup = embeddings.available
  ? embeddings.preload(catalog).catch((error) => { console.warn('Embedding cache warmup failed; price fallback remains active:', error.message); return false; })
  : Promise.resolve(false);
const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(ROOT, 'public');
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const sendJson = (res,status,payload) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(payload)); };
function readBody(req) { return new Promise((resolve,reject)=>{ const chunks=[]; let size=0; req.on('data',(chunk)=>{ size+=chunk.length; if(size>20000){ const e=new Error('Запрос слишком большой.'); e.status=413; reject(e); req.destroy(); } else chunks.push(chunk); }); req.on('end',()=>{ try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { const e=new Error('Тело запроса должно быть JSON.'); e.status=400; reject(e); } }); req.on('error',reject); }); }
const server = http.createServer(async (req,res)=>{
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method==='GET' && url.pathname==='/api/health') return sendJson(res,200,{status:'ok',profiles:catalog.length,dataset:'loaded',ai:embeddings.ready?'available':'fallback',embeddingCache:embeddings.ready?'ready':embeddings.available?'warming':'unavailable'});
    if (req.method==='GET' && url.pathname==='/api/meta') return sendJson(res,200,engine.meta(url.searchParams.get('city') || undefined));
    if (req.method==='POST' && url.pathname==='/api/recommendations') { const input=await readBody(req); const result=await engine.recommend(input); return sendJson(res,result.status,result.body); }
    if (req.method==='GET') { const file=url.pathname==='/'?'index.html':url.pathname.slice(1); if(!['index.html','app.js','styles.css'].includes(file)) return sendJson(res,404,{error:'not_found',message:'Маршрут не найден.'}); const filePath=path.join(publicDir,file); res.writeHead(200,{'Content-Type':mime[path.extname(filePath)],'X-Content-Type-Options':'nosniff'}); return fs.createReadStream(filePath).pipe(res); }
    return sendJson(res,404,{error:'not_found',message:'Маршрут не найден.'});
  } catch(error) { if (res.headersSent || res.destroyed) return; if(error.status){ return sendJson(res,error.status,{error:error.status===413?'payload_too_large':'bad_request',message:error.message}); } console.error('Request failed:',error); return sendJson(res,500,{error:'internal_error',message:'Внутренняя ошибка сервера.'}); }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`HackAlem AI: http://localhost:${PORT} (${catalog.length} профилей; embeddings: ${embeddings.available?'warming':'fallback'})`));
