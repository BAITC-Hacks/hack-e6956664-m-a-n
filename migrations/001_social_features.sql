CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer','contractor')),
  contractor_id TEXT UNIQUE,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((role = 'contractor' AND contractor_id IS NOT NULL) OR (role = 'customer' AND contractor_id IS NULL))
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE contractor_invites (
  code_hash TEXT PRIMARY KEY,
  contractor_id TEXT NOT NULL UNIQUE,
  claimed_by INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contractor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, contractor_id)
);
CREATE TABLE friend_requests (
  id INTEGER PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (requester_id <> addressee_id),
  UNIQUE(requester_id, addressee_id)
);
CREATE TABLE friendships (
  user_low INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_low, user_high),
  CHECK (user_low < user_high)
);
CREATE TABLE dialogs (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contractor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contractor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(customer_id, contractor_user_id),
  CHECK(customer_id <> contractor_user_id)
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  dialog_id INTEGER NOT NULL REFERENCES dialogs(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
  client_nonce TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TEXT
);
CREATE INDEX messages_dialog_order ON messages(dialog_id, id);
CREATE UNIQUE INDEX messages_retry_guard ON messages(dialog_id, sender_id, client_nonce) WHERE client_nonce IS NOT NULL;
CREATE TABLE service_requests (
  id INTEGER PRIMARY KEY,
  seed_key TEXT UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contractor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contractor_id TEXT NOT NULL,
  event_summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('requested','accepted','rejected','fulfilled','completed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(customer_id <> contractor_user_id)
);
CREATE INDEX service_requests_participants ON service_requests(customer_id, contractor_user_id, status);
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  service_request_id INTEGER NOT NULL UNIQUE REFERENCES service_requests(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contractor_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK(is_demo IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX reviews_contractor ON reviews(contractor_id, created_at);
