const { passwordHash, passwordMatches, sha256, issueSession } = require('./identity');

const validName = (v) => typeof v === 'string' && /^[\p{L}\p{N}_.-]{3,24}$/u.test(v.trim());
const normalizeName = (v) => v.trim().toLocaleLowerCase('ru');
const safeUser = (u) => ({ id: u.id, username: u.username, role: u.role, contractorId: u.contractorId || null, isDemo: Boolean(u.isDemo) });

class SocialService {
  constructor(db, catalog) { this.db = db; this.catalog = catalog; this.profileById = new Map(catalog.map((p) => [p.id, p])); }

  async register({ username, password, role = 'customer', inviteCode = '' }) {
    if (!validName(username)) return { status: 400, error: 'Имя пользователя: 3–24 буквы, цифры, точка, дефис или подчёркивание.' };
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) return { status: 400, error: 'Пароль должен содержать от 10 до 128 символов.' };
    if (role !== 'customer' && role !== 'contractor') return { status: 400, error: 'Неизвестная роль.' };
    let contractorId = null;
    if (role === 'contractor') {
      if (!inviteCode || typeof inviteCode !== 'string') return { status: 403, error: 'Регистрация подрядчика доступна только по персональному приглашению.' };
      const invite = this.db.prepare('SELECT contractor_id AS contractorId, claimed_by AS claimedBy FROM contractor_invites WHERE code_hash=?').get(sha256(inviteCode));
      if (!invite || invite.claimedBy) return { status: 403, error: 'Приглашение недействительно или уже использовано.' };
      contractorId = invite.contractorId;
    }
    const key = normalizeName(username);
    if (this.db.prepare('SELECT id FROM users WHERE username_key=?').get(key)) return { status: 409, error: 'Это имя пользователя уже занято.' };
    const encoded = await passwordHash(password);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = this.db.prepare('INSERT INTO users(username,username_key,password_hash,role,contractor_id) VALUES(?,?,?,?,?)').run(username.trim(), key, encoded, role, contractorId);
      const id = Number(result.lastInsertRowid);
      if (contractorId) this.db.prepare('UPDATE contractor_invites SET claimed_by=? WHERE contractor_id=? AND claimed_by IS NULL').run(id, contractorId);
      this.db.exec('COMMIT');
      const session = issueSession(this.db, id);
      return { status: 201, user: { id, username: username.trim(), role, contractorId, isDemo: false }, session };
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} return { status: 409, error: 'Не удалось создать аккаунт. Проверьте имя и приглашение.' }; }
  }

  async login({ username, password }) {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 128) return { status: 400, error: 'Введите имя пользователя и пароль.' };
    const row = this.db.prepare('SELECT id,username,username_key,password_hash,role,contractor_id AS contractorId,is_demo AS isDemo FROM users WHERE username_key=?').get(normalizeName(username));
    if (!row || !(await passwordMatches(password, row.password_hash))) return { status: 401, error: 'Неверное имя пользователя или пароль.' };
    const session = issueSession(this.db, row.id);
    return { status: 200, user: safeUser(row), session };
  }

  profile(contractorId, viewerId = null, friendsFirst = false) {
    const p = this.profileById.get(contractorId);
    if (!p) return null;
    const rows = this.db.prepare(`SELECT r.id,r.author_id AS authorId,u.username,r.rating,r.body,r.is_demo AS isDemo,r.created_at AS createdAt,r.updated_at AS updatedAt
      FROM reviews r JOIN users u ON u.id=r.author_id WHERE r.contractor_id=?`).all(contractorId);
    const friendIds = viewerId == null ? new Set() : new Set(this.db.prepare(`SELECT CASE WHEN user_low=? THEN user_high ELSE user_low END AS friendId FROM friendships WHERE user_low=? OR user_high=?`).all(viewerId, viewerId, viewerId).map((r) => r.friendId));
    const reviews = rows.map((r) => ({ ...r, isDemo: Boolean(r.isDemo), isFriend: friendIds.has(r.authorId) }));
    if (friendsFirst) reviews.sort((a,b) => Number(b.isFriend)-Number(a.isFriend) || b.createdAt.localeCompare(a.createdAt) || a.id-b.id);
    else reviews.sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id-b.id);
    const rating = rows.length ? Number((rows.reduce((sum,r) => sum+r.rating, 0)/rows.length).toFixed(1)) : null;
    const completed = this.db.prepare("SELECT count(*) AS n FROM service_requests WHERE contractor_id=? AND status='completed'").get(contractorId).n;
    return { id:p.id,name:p.name,categories:p.categories,city:p.city,priceFromKzt:p.priceFromKzt,languages:p.languages,maxHours:p.maxHours,description:p.description,synthetic:p.synthetic,priceImputed:p.priceImputed,cityImputed:p.cityImputed,rating,reviewCount:rows.length,completedCount:completed,reviews,ratingsAreDemo:rows.some((r)=>r.isDemo),completedAreDemo:this.db.prepare("SELECT count(*) AS n FROM service_requests WHERE contractor_id=? AND status='completed' AND customer_id IN (SELECT id FROM users WHERE is_demo=1)").get(contractorId).n>0};
  }

  profileStats(contractorId, viewerId = null) { return this.profile(contractorId, viewerId); }
  favorites(user) {
    return this.db.prepare('SELECT contractor_id AS contractorId FROM favorites WHERE user_id=? ORDER BY created_at DESC,contractor_id').all(user.id).map((r) => this.profile(r.contractorId, user.id));
  }
  toggleFavorite(user, contractorId, add) {
    if (!this.profileById.has(contractorId)) return { status:404,error:'Профиль не найден.' };
    if (add) this.db.prepare('INSERT OR IGNORE INTO favorites(user_id,contractor_id) VALUES(?,?)').run(user.id,contractorId);
    else this.db.prepare('DELETE FROM favorites WHERE user_id=? AND contractor_id=?').run(user.id,contractorId);
    return { status:200, saved:Boolean(add) };
  }

  findDialog(user, contractorId, create = false) {
    const vendor = this.db.prepare("SELECT id FROM users WHERE role='contractor' AND contractor_id=?").get(contractorId);
    if (!vendor) return { error: 'Для этого профиля ещё не подключён аккаунт переписки.', status:404 };
    const customerId = user.role === 'customer' ? user.id : vendor.id;
    if (user.role === 'contractor' && user.contractorId !== contractorId) return { error:'Можно открыть переписку только по своему профилю.',status:403 };
    if (user.role === 'customer' && user.id === vendor.id) return { error:'Нельзя начать переписку с самим собой.',status:400 };
    let dialog = this.db.prepare('SELECT * FROM dialogs WHERE customer_id=? AND contractor_user_id=?').get(customerId,vendor.id);
    if (!dialog && create) {
      try { this.db.prepare('INSERT OR IGNORE INTO dialogs(customer_id,contractor_user_id,contractor_id) VALUES(?,?,?)').run(customerId,vendor.id,contractorId); } catch {}
      dialog = this.db.prepare('SELECT * FROM dialogs WHERE customer_id=? AND contractor_user_id=?').get(customerId,vendor.id);
    }
    return dialog ? { dialog, vendorId:vendor.id } : { error:'Диалог не найден.',status:404 };
  }
  dialogAccess(user, id) {
    const dialog = this.db.prepare('SELECT * FROM dialogs WHERE id=?').get(id);
    if (!dialog || (dialog.customer_id !== user.id && dialog.contractor_user_id !== user.id)) return null;
    return dialog;
  }
  dialogList(user) {
    const rows = this.db.prepare(`SELECT d.id,d.contractor_id AS contractorId,d.customer_id AS customerId,d.contractor_user_id AS contractorUserId,
      (SELECT body FROM messages m WHERE m.dialog_id=d.id ORDER BY m.id DESC LIMIT 1) AS lastMessage,
      (SELECT created_at FROM messages m WHERE m.dialog_id=d.id ORDER BY m.id DESC LIMIT 1) AS lastAt,
      (SELECT count(*) FROM messages m WHERE m.dialog_id=d.id AND m.sender_id<>? AND m.read_at IS NULL) AS unreadCount
      FROM dialogs d WHERE d.customer_id=? OR d.contractor_user_id=? ORDER BY COALESCE(lastAt,d.created_at) DESC`).all(user.id,user.id,user.id);
    return rows.map((r) => {
      const otherId = user.id === r.customerId ? r.contractorUserId : r.customerId;
      const other = this.db.prepare('SELECT username,role FROM users WHERE id=?').get(otherId);
      return { id:r.id,contractorId:r.contractorId,contractor:this.profileById.get(r.contractorId)?.name || r.contractorId,otherUsername:other?.username || 'Пользователь',otherRole:other?.role,lastMessage:r.lastMessage || 'Диалог создан',lastAt:r.lastAt || null,unreadCount:r.unreadCount };
    });
  }
  messages(user, dialogId, markRead = false) {
    const dialog = this.dialogAccess(user,dialogId);
    if (!dialog) return null;
    if (markRead) this.db.prepare('UPDATE messages SET read_at=CURRENT_TIMESTAMP WHERE dialog_id=? AND sender_id<>? AND read_at IS NULL').run(dialogId,user.id);
    return this.db.prepare('SELECT id,sender_id AS senderId,body,created_at AS createdAt,read_at AS readAt FROM messages WHERE dialog_id=? ORDER BY id LIMIT 500').all(dialogId).map((r)=>({...r,isMine:r.senderId===user.id}));
  }
  sendMessage(user,dialogId,{body,nonce}) {
    if (!this.dialogAccess(user,dialogId)) return {status:404,error:'Диалог не найден.'};
    if (typeof body !== 'string' || !body.trim() || body.trim().length>4000) return {status:400,error:'Сообщение должно содержать от 1 до 4000 символов.'};
    if (typeof nonce!=='string' || !/^[\w-]{12,80}$/.test(nonce)) return {status:400,error:'Не удалось проверить повторную отправку. Обновите страницу.'};
    const existing=this.db.prepare('SELECT id FROM messages WHERE dialog_id=? AND sender_id=? AND client_nonce=?').get(dialogId,user.id,nonce);
    if(existing) return {status:200,id:existing.id,duplicate:true};
    const created=this.db.prepare('INSERT INTO messages(dialog_id,sender_id,body,client_nonce) VALUES(?,?,?,?)').run(dialogId,user.id,body.trim(),nonce);
    return {status:201,id:Number(created.lastInsertRowid),duplicate:false};
  }

  friends(user) {
    const friends=this.db.prepare(`SELECT u.id,u.username,u.role,u.contractor_id AS contractorId,u.is_demo AS isDemo FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_low=? THEN f.user_high ELSE f.user_low END WHERE f.user_low=? OR f.user_high=?`).all(user.id,user.id,user.id).map(safeUser);
    const incoming=this.db.prepare('SELECT fr.id,u.id AS userId,u.username,u.role FROM friend_requests fr JOIN users u ON u.id=fr.requester_id WHERE fr.addressee_id=? AND fr.status=\'pending\' ORDER BY fr.created_at').all(user.id);
    const outgoing=this.db.prepare('SELECT fr.id,u.id AS userId,u.username,u.role FROM friend_requests fr JOIN users u ON u.id=fr.addressee_id WHERE fr.requester_id=? AND fr.status=\'pending\' ORDER BY fr.created_at').all(user.id);
    return {friends,incoming,outgoing};
  }
  sendFriendRequest(user, username) {
    if (!validName(username)) return {status:400,error:'Введите точное имя пользователя.'};
    const target=this.db.prepare('SELECT id FROM users WHERE username_key=?').get(normalizeName(username));
    if (!target) return {status:404,error:'Пользователь не найден.'};
    if(target.id===user.id) return {status:400,error:'Нельзя добавить себя в друзья.'};
    const [lo,hi]=[user.id,target.id].sort((a,b)=>a-b);
    if(this.db.prepare('SELECT 1 FROM friendships WHERE user_low=? AND user_high=?').get(lo,hi)) return {status:409,error:'Вы уже друзья.'};
    const reverse=this.db.prepare('SELECT id,status FROM friend_requests WHERE requester_id=? AND addressee_id=?').get(target.id,user.id);
    if(reverse?.status==='pending') return {status:409,error:'Этот пользователь уже отправил вам запрос — примите его во входящих.'};
    const own=this.db.prepare('SELECT id,status FROM friend_requests WHERE requester_id=? AND addressee_id=?').get(user.id,target.id);
    if(own?.status==='pending')return {status:409,error:'Запрос уже отправлен.'};
    if(own)this.db.prepare("UPDATE friend_requests SET status='pending',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(own.id);
    else this.db.prepare("INSERT INTO friend_requests(requester_id,addressee_id,status) VALUES(?,?,'pending')").run(user.id,target.id);
    return {status:201};
  }
  respondFriend(user,requestId,accept) {
    const request=this.db.prepare("SELECT requester_id AS requesterId,addressee_id AS addresseeId,status FROM friend_requests WHERE id=?").get(requestId);
    if(!request || request.addresseeId!==user.id || request.status!=='pending') return {status:404,error:'Запрос не найден.'};
    const [lo,hi]=[user.id,request.requesterId].sort((a,b)=>a-b);
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare("UPDATE friend_requests SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(accept?'accepted':'rejected',requestId); if(accept) this.db.prepare('INSERT OR IGNORE INTO friendships(user_low,user_high) VALUES(?,?)').run(lo,hi); this.db.exec('COMMIT'); }
    catch(e){this.db.exec('ROLLBACK');throw e;}
    return {status:200};
  }
  removeFriend(user,friendId) {
    const [lo,hi]=[Number(user.id),Number(friendId)].sort((a,b)=>a-b);
    const result=this.db.prepare('DELETE FROM friendships WHERE user_low=? AND user_high=?').run(lo,hi);
    return result.changes?{status:200}:{status:404,error:'Дружба не найдена.'};
  }

  createRequest(user,contractorId,eventSummary) {
    if(user.role!=='customer') return {status:403,error:'Создать заявку может заказчик.'};
    if(!this.profileById.has(contractorId)) return {status:404,error:'Профиль не найден.'};
    const vendor=this.db.prepare("SELECT id FROM users WHERE role='contractor' AND contractor_id=?").get(contractorId);
    if(!vendor) return {status:404,error:'Для этого профиля ещё не подключён аккаунт подрядчика.'};
    if(typeof eventSummary!=='object'||!eventSummary||Array.isArray(eventSummary)) return {status:400,error:'Добавьте сводку мероприятия.'};
    const safe={date:String(eventSummary.date||'').slice(0,10),city:String(eventSummary.city||'').slice(0,80),eventFormat:String(eventSummary.eventFormat||'').slice(0,80),budgetKzt:Number.isInteger(eventSummary.budgetKzt)?eventSummary.budgetKzt:null,preferences:String(eventSummary.preferences||'').slice(0,500)};
    if(!safe.city||!safe.eventFormat||!safe.date) return {status:400,error:'В сводке нужны город, дата и формат.'};
    const result=this.db.prepare("INSERT INTO service_requests(customer_id,contractor_user_id,contractor_id,event_summary,status) VALUES(?,?,?,?,'requested')").run(user.id,vendor.id,contractorId,JSON.stringify(safe));
    return {status:201,id:Number(result.lastInsertRowid)};
  }
  requests(user) {
    return this.db.prepare('SELECT id,customer_id AS customerId,contractor_user_id AS contractorUserId,contractor_id AS contractorId,event_summary AS eventSummary,status,created_at AS createdAt,updated_at AS updatedAt FROM service_requests WHERE customer_id=? OR contractor_user_id=? ORDER BY id DESC').all(user.id,user.id).map((r)=>({...r,eventSummary:JSON.parse(r.eventSummary),canReview:user.id===r.customerId&&r.status==='completed'}));
  }
  transitionRequest(user,id,next) {
    const r=this.db.prepare('SELECT * FROM service_requests WHERE id=?').get(id);
    if(!r) return {status:404,error:'Заявка не найдена.'};
    const allowed = (r.status==='requested' && r.contractor_user_id===user.id && ['accepted','rejected'].includes(next)) || (r.status==='accepted' && r.contractor_user_id===user.id && next==='fulfilled') || (r.status==='fulfilled' && r.customer_id===user.id && next==='completed');
    if(!allowed) return {status:403,error:'Это действие недоступно для вашей роли или текущего статуса.'};
    const changed=this.db.prepare('UPDATE service_requests SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?').run(next,id,r.status).changes;
    return changed?{status:200}:{status:409,error:'Статус заявки уже изменился.'};
  }
  upsertReview(user,id,{rating,body}) {
    if(user.role!=='customer') return {status:403,error:'Оставить отзыв может только заказчик.'};
    const request=this.db.prepare('SELECT customer_id AS customerId,contractor_id AS contractorId,status FROM service_requests WHERE id=?').get(id);
    if(!request||request.customerId!==user.id||request.status!=='completed') return {status:403,error:'Отзыв доступен только по вашей завершённой заявке.'};
    if(!Number.isInteger(rating)||rating<1||rating>5) return {status:400,error:'Оценка должна быть от 1 до 5.'};
    if(typeof body!=='string'||!body.trim()||body.trim().length>2000) return {status:400,error:'Текст отзыва должен содержать от 1 до 2000 символов.'};
    const existing=this.db.prepare('SELECT id,author_id AS authorId FROM reviews WHERE service_request_id=?').get(id);
    if(existing&&existing.authorId!==user.id) return {status:403,error:'Нельзя редактировать чужой отзыв.'};
    this.db.prepare(`INSERT INTO reviews(service_request_id,author_id,contractor_id,rating,body) VALUES(?,?,?,?,?)
      ON CONFLICT(service_request_id) DO UPDATE SET rating=excluded.rating,body=excluded.body,updated_at=CURRENT_TIMESTAMP WHERE reviews.author_id=excluded.author_id`).run(id,user.id,request.contractorId,rating,body.trim());
    return {status:200};
  }
}

module.exports = { SocialService, validName, normalizeName };
