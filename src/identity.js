const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 1000 * 60 * 60 * 24 * 14;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${derived.toString('hex')}`;
}
async function passwordMatches(password, encoded) {
  const [kind, n, r, p, salt, storedHex] = encoded.split('$');
  if (kind !== 'scrypt' || !salt || !storedHex) return false;
  const actual = await scrypt(password, salt, 64, { N: Number(n), r: Number(r), p: Number(p) });
  const stored = Buffer.from(storedHex, 'hex');
  return stored.length === actual.length && crypto.timingSafeEqual(stored, actual);
}
function setSession(res, raw, expires) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ha_session=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}${secure}`);
}
function clearSession(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ha_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}
function cookieToken(req) {
  const item = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith('ha_session='));
  return item ? decodeURIComponent(item.slice('ha_session='.length)) : '';
}
function issueSession(db, userId) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_MS;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha256(raw), userId, expires);
  return { raw, expires };
}
function currentUser(db, req) {
  const raw = cookieToken(req);
  if (!raw || raw.length > 100) return null;
  const row = db.prepare(`SELECT u.id,u.username,u.role,u.contractor_id AS contractorId,u.is_demo AS isDemo,s.token_hash AS tokenHash
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(sha256(raw), Date.now());
  if (!row) return null;
  return { id: row.id, username: row.username, role: row.role, contractorId: row.contractorId, isDemo: Boolean(row.isDemo), tokenHash: row.tokenHash };
}

module.exports = { passwordHash, passwordMatches, setSession, clearSession, issueSession, currentUser, sha256, SESSION_MS };
