# Live auth check (P0)

Unit tests cover bcrypt → scrypt and JWT cookies. This runbook exercises a **real backend process**.

## Prerequisites

- `backend/.env` has a real `JWT_SECRET`
- Backend running: `npm run server` (default `http://localhost:8000`)

## 1. Scrypt path (signup → me)

```bash
BASE=http://localhost:8000
EMAIL="live-auth-$(date +%s)@example.com"
PASS='validpassword123'

# Signup
curl -sS -c /tmp/fa-cookies.txt -X POST "$BASE/api/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Live Auth\",\"email\":\"$EMAIL\",\"password\":\"$PASS\"}"

# Me with session cookie
curl -sS -b /tmp/fa-cookies.txt "$BASE/api/me"
# Expect 200 JSON with email matching $EMAIL
```

## 2. Legacy bcrypt login + rehash

Use the same bcrypt fixture as `server.test.ts` (password `validpassword123`).

In `sqlite3 backend/databases/FeedbackAssistant.db` (stop server first if locked, or use another db):

```sql
-- Replace IDs/email as needed. bcrypt hash of validpassword123 (cost 10):
INSERT INTO Users (_id, email, name, created_at)
  VALUES ('live-bcrypt-user', 'legacy-live@example.com', 'Legacy', strftime('%s','now')*1000);
INSERT INTO Auths (email, password, userID)
  VALUES (
    'legacy-live@example.com',
    '$2b$10$gix5z78/st4CdQYVM8C4g.ygzzWZQ39pnLKhxVtMWK1HUeASfzIyG',
    'live-bcrypt-user'
  );
```

(That hash is `LEGACY_BCRYPT_HASH` from `backend/server.test.ts` — password `validpassword123`.)

Then:

```bash
BASE=http://localhost:8000
curl -sS -c /tmp/fa-bcrypt.txt -X POST "$BASE/api/signin" \
  -H 'Content-Type: application/json' \
  -d '{"email":"legacy-live@example.com","password":"validpassword123"}'
# Expect 200

# Password column should now start with scrypt$
sqlite3 backend/databases/FeedbackAssistant.db \
  "SELECT substr(password,1,8) FROM Auths WHERE email='legacy-live@example.com';"
```

## 3. JWT cookie

After signin, `/tmp/fa-cookies.txt` (or browser Application → Cookies) should contain an HttpOnly `token` (or app-specific cookie name).  
`GET /api/me` with that cookie → 200 proves JWT verify works for this process.

## 4. Optional: production

Repeat step 1 against the deployed host with a **disposable** account. Never print `JWT_SECRET` or passwords into logs/PRs.

## Pass criteria

- [ ] Signup + `/api/me` 200 (scrypt)
- [ ] Bcrypt fixture signin 200 and row rehashed to `scrypt$`
- [ ] Cookie session accepted on `/api/me`
