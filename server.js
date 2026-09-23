const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT_FOR_ENV = path.resolve(__dirname);
try { for (const line of fs.readFileSync(path.join(ROOT_FOR_ENV, '.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); } } catch {}
const { ROOT, loadCatalog } = require('./src/catalog');
const { createRecommender } = require('./src/recommend');
const { OpenAIEmbeddings } = require('./src/semantic');
const { openDatabase } = require('./src/db');
const { SocialService } = require('./src/social');
const { currentUser, issueSession, clearSession, setSession, sha256 } = require('./src/identity');
const voice = require('./src/voice');

const catalog = loadCatalog();
const embeddings = new OpenAIEmbeddings();
const engine = createRecommender(catalog, embeddings);
const db = openDatabase();
const social = new SocialService(db,catalog);
const cacheWarmup = embeddings.available ? embeddings.preload(catalog).catch((error) => { console.warn('Embedding cache warmup failed; price fallback remains active:', error.message); return false; }) : Promise.resolve(false);
const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(ROOT, 'public');
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const sendJson = (res,status,payload) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(payload)); };
function readBody(req, limit = 20000) { return new Promise((resolve,reject)=>{ const chunks=[]; let size=0; req.on('data',(chunk)=>{ size+=chunk.length; if(size>limit){ const e=new Error('Запрос слишком большой.'); e.status=413; reject(e); req.resume(); } else chunks.push(chunk); }); req.on('end',()=>{ if(size>limit)return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { const e=new Error('Тело запроса должно быть JSON.'); e.status=400; reject(e); } }); req.on('error',reject); }); }
function readAudio(req) { return new Promise((resolve,reject)=>{ const chunks=[];let size=0;req.on('data',(chunk)=>{size+=chunk.length;if(size>voice.MAX_AUDIO_BYTES+65536){const e=new Error('Запись превышает 10 МБ.');e.status=413;reject(e);req.resume();}else chunks.push(chunk);});req.on('end',()=>{if(size>voice.MAX_AUDIO_BYTES+65536)return;const type=req.headers['content-type']||'',match=type.match(/multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i);if(!match){const e=new Error('Передайте аудио как multipart/form-data.');e.status=400;return reject(e);}const boundary=Buffer.from(`--${match[1]||match[2]}`),all=Buffer.concat(chunks);let start=all.indexOf(boundary);while(start>=0){start+=boundary.length;if(all.subarray(start,start+2).equals(Buffer.from('--')))break;if(all.subarray(start,start+2).equals(Buffer.from('\r\n')))start+=2;const headEnd=all.indexOf(Buffer.from('\r\n\r\n'),start);if(headEnd<0)break;const headers=all.subarray(start,headEnd).toString('utf8');const next=all.indexOf(boundary,headEnd+4);if(next<0)break;let end=next;if(all.subarray(end-2,end).equals(Buffer.from('\r\n')))end-=2;const data=all.subarray(headEnd+4,end);if(/name="audio"/i.test(headers)){const mime=headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim()||'';const declared=Number(req.headers['x-audio-duration']||0);if(declared&&declared>voice.MAX_AUDIO_SECONDS){const e=new Error('Максимальная длительность записи — 30 секунд.');e.status=413;return reject(e);}return resolve({buffer:data,mimeType:mime});}start=next;}const e=new Error('Аудиофайл не найден.');e.status=400;reject(e);});req.on('error',reject);}); }
const limits=new Map();
function allow(key,max,windowMs){const now=Date.now(),hits=(limits.get(key)||[]).filter((x)=>now-x<windowMs);if(hits.length>=max){limits.set(key,hits);return false;}hits.push(now);limits.set(key,hits);return true;}
const cleanUser=(user)=>user?({id:user.id,username:user.username,role:user.role,contractorId:user.contractorId,isDemo:user.isDemo}):null;
function requireUser(req,res,role){const user=currentUser(db,req);if(!user){sendJson(res,401,{error:'auth_required',message:'Войдите в аккаунт, чтобы продолжить.'});return null;}if(role&&user.role!==role){sendJson(res,403,{error:'forbidden',message:'Операция недоступна для этой роли.'});return null;}return user;}
function result(res,r){return sendJson(res,r.status||200,r.error?{error:'request_failed',message:r.error}:r);}
function sameOrigin(req){const origin=req.headers.origin;if(!origin)return true;try{return new URL(origin).host===(req.headers.host||'');}catch{return false;}}

const server = http.createServer(async (req,res)=>{
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const user=currentUser(db,req);
    if(req.method!=='GET'&&!sameOrigin(req))return sendJson(res,403,{error:'forbidden',message:'Запрос отклонён.'});

    if(req.method==='GET'&&url.pathname==='/api/health')return sendJson(res,200,{status:'ok',profiles:catalog.length,dataset:'loaded',ai:embeddings.ready?'available':'fallback',embeddingCache:embeddings.ready?'ready':embeddings.available?'warming':'unavailable',database:'sqlite',voiceAI:Boolean(process.env.AI_API_KEY||process.env.OPENAI_API_KEY)});
    if(req.method==='GET'&&url.pathname==='/api/meta')return sendJson(res,200,engine.meta(url.searchParams.get('city')||undefined));
    if(req.method==='POST'&&url.pathname==='/api/recommendations'){const input=await readBody(req);const r=await engine.recommend(input);return sendJson(res,r.status,r.body);}

    if(req.method==='POST'&&url.pathname==='/api/voice/transcribe'){
      const ip=req.socket.remoteAddress||'unknown';if(!allow(`voice:${ip}`,8,60000))return sendJson(res,429,{error:'rate_limited',message:'Слишком много запросов. Подождите минуту.'});
      const audio=await readAudio(req);const answer=await voice.transcribeAudio(audio.buffer,audio.mimeType);return sendJson(res,200,answer);
    }
    if(req.method==='POST'&&url.pathname==='/api/voice/parse'){
      const input=await readBody(req,12000);const answer=await voice.parseTranscript(input.transcript,catalog,input.currentValues||{});return sendJson(res,200,answer);
    }

    if(req.method==='GET'&&url.pathname==='/api/auth/me')return sendJson(res,200,{user:cleanUser(user)});
    if(req.method==='POST'&&url.pathname==='/api/auth/register'){
      const input=await readBody(req);const r=await social.register({username:input.username,password:input.password,role:input.role,inviteCode:input.inviteCode});
      if(r.session){setSession(res,r.session.raw,r.session.expires);return sendJson(res,r.status,{user:r.user});}return sendJson(res,r.status,{error:'registration_failed',message:r.error});
    }
    if(req.method==='POST'&&url.pathname==='/api/auth/login'){
      const ip=req.socket.remoteAddress||'unknown';if(!allow(`login:${ip}`,12,60000))return sendJson(res,429,{error:'rate_limited',message:'Слишком много попыток входа. Подождите минуту.'});
      const input=await readBody(req);const r=await social.login(input);if(r.session){setSession(res,r.session.raw,r.session.expires);return sendJson(res,r.status,{user:r.user});}return sendJson(res,r.status,{error:'login_failed',message:r.error});
    }
    if(req.method==='POST'&&url.pathname==='/api/auth/logout'){
      const raw=(req.headers.cookie||'').split(';').map((x)=>x.trim()).find((x)=>x.startsWith('ha_session='))?.slice('ha_session='.length);if(raw)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(decodeURIComponent(raw)));clearSession(res);return sendJson(res,200,{ok:true});
    }

    const profileMatch=url.pathname.match(/^\/api\/profiles\/([A-Za-z0-9-]+)$/);
    if(req.method==='GET'&&profileMatch){const data=social.profile(decodeURIComponent(profileMatch[1]),user?.id||null,url.searchParams.get('friendsFirst')==='true');if(!data)return sendJson(res,404,{error:'not_found',message:'Профиль не найден.'});return sendJson(res,200,data);}

    if(req.method==='GET'&&url.pathname==='/api/favorites'){const u=requireUser(req,res,'customer');if(!u)return;return sendJson(res,200,{items:social.favorites(u)});}
    const favoriteMatch=url.pathname.match(/^\/api\/favorites\/([A-Za-z0-9-]+)$/);
    if(req.method==='PUT'&&favoriteMatch){const u=requireUser(req,res,'customer');if(!u)return;const body=await readBody(req,3000);return result(res,social.toggleFavorite(u,decodeURIComponent(favoriteMatch[1]),body.saved===true));}
    if(req.method==='POST'&&url.pathname==='/api/favorites/check'){
      const u=requireUser(req,res,'customer');if(!u)return;const input=await readBody(req);const rows=db.prepare('SELECT contractor_id AS id FROM favorites WHERE user_id=?').all(u.id);const statuses={};for(const row of rows)statuses[row.id]=engine.checkProfile(input,row.id).valid;return sendJson(res,200,{statuses});
    }

    if(req.method==='GET'&&url.pathname==='/api/dialogs'){const u=requireUser(req,res);if(!u)return;return sendJson(res,200,{items:social.dialogList(u)});}
    if(req.method==='POST'&&url.pathname==='/api/dialogs/open'){const u=requireUser(req,res,'customer');if(!u)return;const body=await readBody(req);const opened=social.findDialog(u,body.contractorId,true);if(opened.error)return sendJson(res,opened.status,{error:'dialog_unavailable',message:opened.error});return sendJson(res,200,{id:opened.dialog.id});}
    const dialogMessages=url.pathname.match(/^\/api\/dialogs\/(\d+)\/messages$/);
    if(req.method==='GET'&&dialogMessages){const u=requireUser(req,res);if(!u)return;const items=social.messages(u,Number(dialogMessages[1]),true);if(!items)return sendJson(res,404,{error:'not_found',message:'Диалог не найден.'});return sendJson(res,200,{items});}
    if(req.method==='POST'&&dialogMessages){const u=requireUser(req,res);if(!u)return;if(!allow(`message:${u.id}`,30,60000))return sendJson(res,429,{error:'rate_limited',message:'Слишком часто. Подождите минуту.'});const body=await readBody(req,8000);return result(res,social.sendMessage(u,Number(dialogMessages[1]),body));}
    const dialogRequest=url.pathname.match(/^\/api\/dialogs\/(\d+)\/requests$/);
    if(req.method==='POST'&&dialogRequest){const u=requireUser(req,res,'customer');if(!u)return;const dialog=social.dialogAccess(u,Number(dialogRequest[1]));if(!dialog)return sendJson(res,404,{error:'not_found',message:'Диалог не найден.'});const body=await readBody(req);return result(res,social.createRequest(u,dialog.contractor_id,body.eventSummary));}

    if(req.method==='GET'&&url.pathname==='/api/friends'){const u=requireUser(req,res);if(!u)return;return sendJson(res,200,social.friends(u));}
    if(req.method==='POST'&&url.pathname==='/api/friends/requests'){const u=requireUser(req,res);if(!u)return;const body=await readBody(req,3000);return result(res,social.sendFriendRequest(u,body.username));}
    const friendReq=url.pathname.match(/^\/api\/friends\/requests\/(\d+)$/);
    if(req.method==='PATCH'&&friendReq){const u=requireUser(req,res);if(!u)return;const body=await readBody(req,3000);if(typeof body.accept!=='boolean')return sendJson(res,400,{error:'bad_request',message:'Укажите действие для запроса.'});return result(res,social.respondFriend(u,Number(friendReq[1]),body.accept));}
    const friendDelete=url.pathname.match(/^\/api\/friends\/(\d+)$/);
    if(req.method==='DELETE'&&friendDelete){const u=requireUser(req,res);if(!u)return;return result(res,social.removeFriend(u,Number(friendDelete[1])));}

    if(req.method==='GET'&&url.pathname==='/api/requests'){const u=requireUser(req,res);if(!u)return;return sendJson(res,200,{items:social.requests(u)});}
    if(req.method==='POST'&&url.pathname==='/api/requests'){const u=requireUser(req,res,'customer');if(!u)return;const body=await readBody(req,12000);return result(res,social.createRequest(u,body.contractorId,body.eventSummary));}
    const requestTransition=url.pathname.match(/^\/api\/requests\/(\d+)\/status$/);
    if(req.method==='PATCH'&&requestTransition){const u=requireUser(req,res);if(!u)return;const body=await readBody(req,3000);return result(res,social.transitionRequest(u,Number(requestTransition[1]),body.status));}
    const requestReview=url.pathname.match(/^\/api\/requests\/(\d+)\/review$/);
    if(req.method==='PUT'&&requestReview){const u=requireUser(req,res,'customer');if(!u)return;const body=await readBody(req,5000);return result(res,social.upsertReview(u,Number(requestReview[1]),body));}

    if(req.method==='GET'){const file=url.pathname==='/'?'index.html':url.pathname.slice(1);if(!['index.html','app.js','styles.css'].includes(file))return sendJson(res,404,{error:'not_found',message:'Маршрут не найден.'});const filePath=path.join(publicDir,file);res.writeHead(200,{'Content-Type':mime[path.extname(filePath)],'X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});return fs.createReadStream(filePath).pipe(res);}
    return sendJson(res,404,{error:'not_found',message:'Маршрут не найден.'});
  } catch(error) { if(res.headersSent||res.destroyed)return;if(error.status)return sendJson(res,error.status,{error:'request_failed',message:error.message});console.error('Request failed:',error);return sendJson(res,500,{error:'internal_error',message:'Внутренняя ошибка сервера.'}); }
});
const cleanup=setInterval(()=>db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now()),60*60*1000);cleanup.unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`HackAlem AI: http://localhost:${PORT} (${catalog.length} профилей; sqlite; embeddings: ${embeddings.available?'warming':'fallback'})`));
function close(){clearInterval(cleanup);server.close(()=>{db.close();process.exit(0);});}
process.on('SIGINT',close);process.on('SIGTERM',close);
