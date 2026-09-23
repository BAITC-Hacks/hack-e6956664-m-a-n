ALTER TABLE service_requests ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1));
ALTER TABLE messages ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1));
UPDATE service_requests SET is_demo=1 WHERE seed_key IS NOT NULL OR customer_id IN (SELECT id FROM users WHERE is_demo=1);
UPDATE messages SET is_demo=1 WHERE sender_id IN (SELECT id FROM users WHERE is_demo=1) OR client_nonce LIKE 'demo-%';
