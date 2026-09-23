const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openDatabase}=require('../src/db');
const {loadCatalog}=require('../src/catalog');
const {SocialService}=require('../src/social');
const {passwordHash,passwordMatches}=require('../src/identity');
const {validateDraft,parseTranscript,transcribeAudio,MAX_AUDIO_BYTES,MAX_AUDIO_SECONDS}=require('../src/voice');

const file=path.join(os.tmpdir(),`hackalem-social-${process.pid}-${Date.now()}.sqlite`);
const catalog=loadCatalog();
const profileId=catalog.find((p)=>p.id==='HK-44733')?.id||catalog.find((p)=>p.city==='Алматы').id;
let db,social,customer,friend,stranger,vendor;
test.before(()=>{
  db=openDatabase(file);social=new SocialService(db,catalog);
  const insert=db.prepare('INSERT INTO users(username,username_key,password_hash,role,contractor_id) VALUES(?,?,?,?,?)');
  customer=Number(insert.run('customer.test','customer.test','x','customer',null).lastInsertRowid);
  friend=Number(insert.run('friend.test','friend.test','x','customer',null).lastInsertRowid);
  stranger=Number(insert.run('stranger.test','stranger.test','x','customer',null).lastInsertRowid);
  vendor=Number(insert.run('vendor.test','vendor.test','x','contractor',profileId).lastInsertRowid);
});
test.after(()=>{db?.close();for(const suffix of ['', '-wal','-shm'])try{fs.unlinkSync(file+suffix);}catch{}});

test('migrations are idempotent',()=>{const before=db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n;require('../src/db').migrate(db);assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n,before);});
test('empty profiles have no invented rating or completed work',()=>{const other=catalog.find((p)=>p.id!==profileId);const stats=social.profile(other.id);assert.equal(stats.rating,null);assert.equal(stats.reviewCount,0);assert.equal(stats.completedCount,0);});
test('reviews and service completion count are separately computed and editable',()=>{
  const r=social.createRequest({id:customer,role:'customer'},profileId,{date:'2026-10-15',city:'Алматы',eventFormat:'корпоратив',budgetKzt:1500000,preferences:''});assert.equal(r.status,201);
  assert.equal(social.transitionRequest({id:vendor,role:'contractor'},r.id,'accepted').status,200);
  assert.equal(social.transitionRequest({id:vendor,role:'contractor'},r.id,'fulfilled').status,200);
  assert.equal(social.transitionRequest({id:customer,role:'customer'},r.id,'completed').status,200);
  assert.notEqual(social.transitionRequest({id:customer,role:'customer'},r.id,'completed').status,200);
  const review=social.upsertReview({id:customer,role:'customer'},r.id,{rating:4,body:'Хорошо'});assert.equal(review.status,200);
  assert.equal(social.upsertReview({id:customer,role:'customer'},r.id,{rating:5,body:'Обновлено'}).status,200);
  const p=social.profile(profileId);assert.equal(p.rating,5);assert.equal(p.reviewCount,1);assert.equal(p.completedCount,1);
  assert.equal(social.upsertReview({id:stranger,role:'customer'},r.id,{rating:1,body:'Чужой'}).status,403);
  assert.equal(social.upsertReview({id:vendor,role:'contractor'},r.id,{rating:1,body:'Сам себе'}).status,403);
});
test('reviews require customer own completed request and no duplicate completion',()=>{
  const r=social.createRequest({id:customer,role:'customer'},profileId,{date:'2026-10-16',city:'Алматы',eventFormat:'корпоратив',budgetKzt:1200000});
  assert.equal(social.upsertReview({id:customer,role:'customer'},r.id,{rating:5,body:'Рано'}).status,403);
  assert.equal(social.transitionRequest({id:customer,role:'customer'},r.id,'completed').status,403);
  assert.equal(db.prepare('SELECT count(*) AS n FROM reviews WHERE service_request_id=?').get(r.id).n,0);
});
test('favorite writes are unique and persist in sqlite',()=>{
  social.toggleFavorite({id:customer,role:'customer'},profileId,true);social.toggleFavorite({id:customer,role:'customer'},profileId,true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM favorites WHERE user_id=? AND contractor_id=?').get(customer,profileId).n,1);
  assert.equal(social.favorites({id:customer}).length,1);
});
test('messages require participant access and client retry nonce is idempotent',()=>{
  const opened=social.findDialog({id:customer,role:'customer'},profileId,true);assert.ok(opened.dialog.id);
  const payload={body:'Здравствуйте',nonce:'nonce-test-123456'};
  assert.equal(social.sendMessage({id:customer},opened.dialog.id,payload).status,201);
  assert.equal(social.sendMessage({id:customer},opened.dialog.id,payload).duplicate,true);
  assert.equal(social.sendMessage({id:vendor},opened.dialog.id,{body:'Ответ',nonce:'nonce-vendor-123456'}).status,201);
  assert.equal(social.messages({id:stranger},opened.dialog.id),null);
  assert.equal(social.messages({id:customer},opened.dialog.id,true).length,2);
  assert.ok(social.messages({id:vendor},opened.dialog.id).find((m)=>m.isMine).readAt);
});
test('friend requests require acceptance and reject duplicates/self requests',()=>{
  assert.equal(social.sendFriendRequest({id:customer},'stranger.test').status,201);
  assert.equal(social.sendFriendRequest({id:customer},'stranger.test').status,409);
  assert.equal(social.sendFriendRequest({id:customer},'customer.test').status,400);
  const request=social.friends({id:stranger}).incoming[0];assert.ok(request);
  assert.equal(social.respondFriend({id:stranger},request.id,true).status,200);
  assert.equal(social.friends({id:customer}).friends.some((x)=>x.id===stranger),true);
});
test('friend review highlight is derived from accepted friendship and disappears on removal',()=>{
  db.prepare('INSERT INTO friendships(user_low,user_high) VALUES(?,?)').run(...[customer,friend].sort((a,b)=>a-b));
  const r=social.createRequest({id:friend,role:'customer'},profileId,{date:'2026-10-17',city:'Алматы',eventFormat:'корпоратив',budgetKzt:1000000});
  db.prepare("UPDATE service_requests SET status='completed' WHERE id=?").run(r.id);
  social.upsertReview({id:friend,role:'customer'},r.id,{rating:5,body:'Демо друг'});
  assert.ok(social.profile(profileId,customer).reviews.find((x)=>x.authorId===friend).isFriend);
  assert.equal(social.profile(profileId,stranger).reviews.find((x)=>x.authorId===friend).isFriend,false);
  assert.equal(social.removeFriend({id:customer},friend).status,200);
  assert.equal(social.profile(profileId,customer).reviews.find((x)=>x.authorId===friend).isFriend,false);
});
test('voice suggestions only map known catalog values and flag ambiguous/out-of-range fields',()=>{
  const good=validateDraft({city:'Алматы',category:'Ведущий',eventFormat:'корпоратив',date:'2026-10-15',budgetKzt:1500000,language:'русский',durationHours:6,preferences:'спокойно'},catalog,new Date('2026-09-23T12:00:00Z'));
  assert.equal(good.suggestions.category,'Ведущий');assert.equal(good.suggestions.budgetKzt,1500000);
  const bad=validateDraft({city:'Несуществующий город',category:'Гармонист',eventFormat:'корпоратив',date:'2027-01-10',budgetKzt:null,language:null,durationHours:50,preferences:''},catalog,new Date('2026-09-23T12:00:00Z'));
  assert.equal(bad.suggestions.city,null);assert.equal(bad.suggestions.category,null);assert.equal(bad.suggestions.date,null);assert.ok(bad.clarifications.length>=4);
});
test('voice extraction uses a structured test provider and does not assume missing values',async()=>{
  const old=process.env.AI_API_KEY;process.env.AI_API_KEY='test-only';
  try{const output={city:'Алматы',category:'Ведущий',eventFormat:'корпоратив',date:'2026-10-15',budgetKzt:1500000,language:'русский',durationHours:6,preferences:'без конкурсов',clarifications:[]};const existing={city:'Астана',date:'2026-10-07',eventFormat:'корпоратив',category:'Ведущий',budgetKzt:900000,language:'русский',durationHours:4,preferences:''};const result=await parseTranscript('Алматы, корпоратив, ведущий',catalog,existing,async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/chat/completions');assert.equal(JSON.parse(options.body).temperature,0);return{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(output)}}]})};},new Date('2026-09-23T12:00:00Z'));assert.equal(result.suggestions.city,'Алматы');assert.equal(result.suggestions.category,'Ведущий');assert.deepEqual(new Set(result.overwriteFields),new Set(['city','date','budgetKzt','durationHours']));}finally{if(old===undefined)delete process.env.AI_API_KEY;else process.env.AI_API_KEY=old;}
});
test('voice upload constraints are explicit',()=>{assert.equal(MAX_AUDIO_SECONDS,30);assert.equal(MAX_AUDIO_BYTES,10*1024*1024);});
test('passwords are stored as scrypt hashes and contractor profile claims require one-use invite',async()=>{
  const encoded=await passwordHash('StrongDemoPass2026!');assert.notEqual(encoded,'StrongDemoPass2026!');assert.match(encoded,/^scrypt\$/);assert.equal(await passwordMatches('StrongDemoPass2026!',encoded),true);assert.equal(await passwordMatches('wrong',encoded),false);
  assert.equal((await social.register({username:'vendor.claim',password:'StrongDemoPass2026!',role:'contractor'})).status,403);
  const code='only-one-invite';db.prepare('INSERT INTO contractor_invites(code_hash,contractor_id) VALUES(?,?)').run(require('../src/identity').sha256(code),catalog.find((p)=>p.id!==profileId).id);
  const claim=await social.register({username:'vendor.claim',password:'StrongDemoPass2026!',role:'contractor',inviteCode:code});assert.equal(claim.status,201);assert.ok(claim.user.contractorId);assert.equal((await social.register({username:'vendor.claim2',password:'StrongDemoPass2026!',role:'contractor',inviteCode:code})).status,403);
});
test('audio upload uses a mock provider, rejects unknown format, and handles missing key',async()=>{
  const old=process.env.AI_API_KEY,oldOpen=process.env.OPENAI_API_KEY;process.env.AI_API_KEY='test-only';delete process.env.OPENAI_API_KEY;
  try{const answer=await transcribeAudio(Buffer.from('fake audio'),'audio/webm',async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');assert.equal(options.headers.Authorization,'Bearer test-only');assert.equal(options.body.get('model'),'gpt-transcribe');return{ok:true,json:async()=>({text:'Запрос на казахском языке'})};});assert.equal(answer.transcript,'Запрос на казахском языке');await assert.rejects(()=>transcribeAudio(Buffer.from('audio'),'image/png'),(e)=>e.status===415);}finally{if(old===undefined)delete process.env.AI_API_KEY;else process.env.AI_API_KEY=old;if(oldOpen===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldOpen;}
  const a=process.env.AI_API_KEY,b=process.env.OPENAI_API_KEY;delete process.env.AI_API_KEY;delete process.env.OPENAI_API_KEY;try{await assert.rejects(()=>transcribeAudio(Buffer.from('fake audio'),'audio/webm'),(e)=>e.status===503);}finally{if(a!==undefined)process.env.AI_API_KEY=a;if(b!==undefined)process.env.OPENAI_API_KEY=b;}
});
