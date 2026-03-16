# Daily Prep Coach

90-day backend engineering bootcamp tracker with AI-generated daily plans, cumulative topic memory, and persistent session logging.

## Stack

- **Runtime**: Node.js 20
- **Server**: Express
- **Storage**: SQLite (better-sqlite3) — file in `/tmp` on Heroku, `./dpc-data.db` locally
- **Frontend**: Vanilla HTML/JS served from `/public`
- **AI**: Anthropic Claude API (called from the browser)

## How persistence works

```
Browser localStorage  ←→  Express API  ←→  SQLite
     (primary)              (mirror)       (/tmp on Heroku)
```

- Every save writes to **localStorage first**, then mirrors to the backend.
- On page load, the frontend checks if the backend SQLite is empty — if so, it **auto-reseeds** from localStorage.
- This means Heroku dyno restarts (which wipe `/tmp`) are completely transparent — data is restored automatically on next visit.

## Local development

```bash
git clone https://github.com/vskrch/daily-prep-coach.git
cd daily-prep-coach
npm install
cp .env.example .env
npm run dev
# → http://localhost:3000
```

## Deploy to Heroku

### 1. Push this repo to GitHub

```bash
git init
git add .
git commit -m "feat: initial commit"
git remote add origin https://github.com/vskrch/daily-prep-coach.git
git branch -M main
git push -u origin main
```

### 2. Create Heroku app

```bash
heroku login
heroku create daily-prep-coach-vsk
```

### 3. Connect GitHub → Heroku (auto-deploy)

1. Go to https://dashboard.heroku.com → your app → **Deploy** tab
2. Deployment method → **GitHub**
3. Connect to `vskrch/daily-prep-coach`
4. Enable **Automatic deploys** from `main`
5. Click **Deploy Branch** to trigger first build

### 4. Set env var

```bash
heroku config:set NODE_ENV=production --app daily-prep-coach-vsk
```

### 5. Verify

```bash
curl https://daily-prep-coach-vsk.herokuapp.com/health
# {"ok":true,"storage":"sqlite","version":"2.0.0"}
```

### 6. Open the app

Visit `https://daily-prep-coach-vsk.herokuapp.com` — click **settings**, your user key is auto-generated. **Save it in a password manager.**

## Heroku dyno choice

| Dyno | Cost | Sleep? |
|------|------|--------|
| Eco  | $5/mo shared | Yes, after 30min idle |
| Basic | $7/mo | No |
| Standard-1X | $25/mo | No |

Eco is fine for daily personal use — the auto-reseed handles any data loss from sleeping. Basic is the sweet spot if you want it always-on.

## Useful commands

```bash
heroku logs --tail --app daily-prep-coach-vsk
heroku restart --app daily-prep-coach-vsk
heroku ps --app daily-prep-coach-vsk
```

## Edge cases

| Scenario | Handled by |
|---|---|
| Dyno restart wipes SQLite | Frontend auto-reseeds on next load |
| Backend unreachable | Falls back to localStorage silently |
| New device | Enter backend URL + user key in settings → restored |
| Lost user key | Embedded in every Export Backup JSON |
| Want to add Postgres later | Swap `db.js` — all callers use the same interface |
