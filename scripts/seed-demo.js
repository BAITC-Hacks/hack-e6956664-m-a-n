const crypto = require('node:crypto');
const { openDatabase } = require('../src/db');
const { loadCatalog } = require('../src/catalog');
const { passwordHash, sha256 } = require('../src/identity');

async function main() {
  const db=openDatabase();
  const catalog=loadCatalog();
  const inviteProfile=process.argv[2];
  if(inviteProfile) {
    if(!catalog.some((p)=>p.id===inviteProfile)) throw new Error('Такого ID профиля нет в CSV.');
    if(db.prepare('SELECT 1 FROM users WHERE contractor_id=?').get(inviteProfile)) throw new Error('Для профиля уже зарегистрирован подрядчик.');
    if(db.prepare('SELECT 1 FROM contractor_invites WHERE contractor_id=?').get(inviteProfile)) throw new Error('Для профиля уже существует приглашение.');
    const code=crypto.randomBytes(18).toString('base64url');
    db.prepare('INSERT INTO contractor_invites(code_hash,contractor_id) VALUES(?,?)').run(sha256(code),inviteProfile);
    console.log(`Одноразовое приглашение для ${inviteProfile}: ${code}`);
    db.close(); return;
  }

  const password=process.env.DEMO_PASSWORD || 'HackAlemDemo2026!';
  if(password.length<10) throw new Error('DEMO_PASSWORD должен быть минимум 10 символов.');
  const vendorProfile=catalog.find((p)=>p.id==='HK-44733') || catalog.find((p)=>p.categories.includes('Ведущий')&&p.city==='Алматы');
  if(!vendorProfile) throw new Error('В CSV нет demo профиля ведущего.');
  const accounts=[
    {username:'demo.customer',role:'customer'},
    {username:'demo.friend',role:'customer'},
    {username:'demo.outsider',role:'customer'},
    {username:'demo.vendor',role:'contractor',contractorId:vendorProfile.id},
  ];
  for(const account of accounts) {
    const usernameKey=account.username.toLocaleLowerCase('ru');
    if(!db.prepare('SELECT 1 FROM users WHERE username_key=?').get(usernameKey)) {
      const hash=await passwordHash(password);
      db.prepare('INSERT INTO users(username,username_key,password_hash,role,contractor_id,is_demo) VALUES(?,?,?,?,?,1)').run(account.username,usernameKey,hash,account.role,account.contractorId||null);
    }
  }
  const user=(name)=>db.prepare('SELECT id FROM users WHERE username_key=?').get(name).id;
  const customer=user('demo.customer'), friend=user('demo.friend'), outsider=user('demo.outsider'), vendor=user('demo.vendor');
  const pair=[customer,friend].sort((a,b)=>a-b);
  db.prepare('INSERT OR IGNORE INTO friendships(user_low,user_high) VALUES(?,?)').run(...pair);
  const req=db.prepare('INSERT OR IGNORE INTO service_requests(seed_key,customer_id,contractor_user_id,contractor_id,event_summary,status) VALUES(?,?,?,?,?,?)');
  req.run('demo-review-friend-v1',friend,vendor,vendorProfile.id,JSON.stringify({date:'2026-10-15',city:vendorProfile.city,eventFormat:'корпоратив',budgetKzt:1500000,preferences:'Демонстрационная заявка'}),'completed');
  req.run('demo-review-customer-v1',customer,vendor,vendorProfile.id,JSON.stringify({date:'2026-10-20',city:vendorProfile.city,eventFormat:'корпоратив',budgetKzt:1500000,preferences:'Демонстрационная заявка'}),'completed');
  const friendReq=db.prepare("SELECT id FROM service_requests WHERE seed_key='demo-review-friend-v1'").get().id;
  const ownReq=db.prepare("SELECT id FROM service_requests WHERE seed_key='demo-review-customer-v1'").get().id;
  db.prepare('INSERT OR IGNORE INTO reviews(service_request_id,author_id,contractor_id,rating,body,is_demo) VALUES(?,?,?,?,?,1)').run(friendReq,friend,vendorProfile.id,5,'Демонстрационный отзыв друга: спокойное ведение и чёткая организация вечера.');
  db.prepare('INSERT OR IGNORE INTO reviews(service_request_id,author_id,contractor_id,rating,body,is_demo) VALUES(?,?,?,?,?,1)').run(ownReq,customer,vendorProfile.id,4,'Демонстрационный отзыв: внимательное отношение к программе мероприятия.');
  db.prepare('INSERT OR IGNORE INTO favorites(user_id,contractor_id) VALUES(?,?)').run(customer,vendorProfile.id);
  db.prepare('INSERT OR IGNORE INTO dialogs(customer_id,contractor_user_id,contractor_id) VALUES(?,?,?)').run(customer,vendor,vendorProfile.id);
  const dialog=db.prepare('SELECT id FROM dialogs WHERE customer_id=? AND contractor_user_id=?').get(customer,vendor).id;
  db.prepare("INSERT OR IGNORE INTO messages(dialog_id,sender_id,body,client_nonce) VALUES(?,?,?,'demo-msg-customer-v1')").run(dialog,customer,'Демонстрация: здравствуйте! Подскажите, пожалуйста, свободны ли вы на дату мероприятия?');
  db.prepare("INSERT OR IGNORE INTO messages(dialog_id,sender_id,body,client_nonce) VALUES(?,?,?,'demo-msg-vendor-v1')").run(dialog,vendor,'Демонстрация: здравствуйте! Готов обсудить программу и детали.');
  // Explicitly mark demo accounts and rows so these examples are never mistaken for verified marketplace history.
  console.log(`Демо-данные готовы (идемпотентно). Аккаунты: demo.customer, demo.friend, demo.outsider, demo.vendor; профиль подрядчика: ${vendorProfile.id}. Пароль: ${password}`);
  db.close();
}
main().catch((error)=>{console.error(error.message);process.exitCode=1;});
