# Callback Tracker

Internal tool for Super Eagle Auto Care. Pulls **closed repair orders** from Tekmetric
each night and turns the **declined work** into a callback list your advisors work through.
Notes, completions, and follow-ups live in this app — nothing is written back to Tekmetric.

- **Advisors** see the callback list (Active / Follow-ups / Completed) and log their calls.
- **Managers** also get a per-advisor scoreboard.
- **Owner** manages who's a manager and can grant access to outside (guest) emails.

---

## How it works

- **Sign-in:** Google. Anyone at your company domain gets in automatically; guests can be added by the owner.
- **Nightly sync (3 AM):** pulls only ROs that *changed* since the last run, heavily rate-limited so it never strains the Tekmetric API. Users never trigger a pull — the app reads only its own database.
- **One service:** the website, the API, and the nightly job all run together on Railway.

---

## Deploy to Railway (first time)

### 1. Put the code on GitHub
Create a new repo and push this folder to it.

### 2. Create the Railway project
1. Railway → **New Project → Deploy from GitHub repo** → pick this repo.
2. In the project, **New → Database → Add PostgreSQL**. Railway sets `DATABASE_URL` automatically.

### 3. Set environment variables
On the app service → **Variables**, add everything from `.env.example` (except `DATABASE_URL`, which Railway provides):

| Variable | Value |
|---|---|
| `SESSION_SECRET` | any long random string |
| `APP_BASE_URL` | your Railway public URL, e.g. `https://callbacks.up.railway.app` |
| `TEKMETRIC_CLIENT_ID` / `TEKMETRIC_CLIENT_SECRET` | from your Tekmetric API application |
| `TEKMETRIC_SHOP_ID` | `760` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from step 4 below |
| `ALLOWED_DOMAIN` | your workspace domain, e.g. `precisionauto.com` |
| `OWNER_EMAIL` | your email (the owner) |

The rate-limit knobs (`TEKMETRIC_MAX_RPS`, etc.) already have safe defaults — only set them to override.

### 4. Create the Google sign-in
1. [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services → Credentials**.
2. **Create Credentials → OAuth client ID → Web application**.
3. Under **Authorized redirect URIs**, add: `https://YOUR-RAILWAY-URL/auth/callback`
4. Copy the **Client ID** and **Client secret** into the Railway variables above.

### 5. Deploy + first backfill
1. Railway redeploys automatically. The database tables are created on boot.
2. Load the first month of data: on the service, run a one-off command
   **`npm run sync -- full`** (Railway → service → **Settings → Deploy → Run command**, or `railway run npm run sync -- full` from the CLI).
3. After that, the built-in 3 AM job keeps it current — nothing else to do.

### 6. Pin it in your Google Site
Add the Railway URL as a link/button on your company Google Site, like your other apps.

---

## Running locally (optional)

```bash
npm install
cp .env.example .env      # fill in values; point DATABASE_URL at a local Postgres
npm run migrate           # create tables
npm run sync -- full      # first backfill
npm run dev               # http://localhost:3000
```

Without `GOOGLE_CLIENT_ID` set, the app uses a **local dev login** (signs you in as the owner)
so you can click around before wiring up Google.

## Commands

| Command | What it does |
|---|---|
| `npm start` | run the server (Railway uses this) |
| `npm run dev` | run with auto-reload |
| `npm run migrate` | create/update database tables |
| `npm run sync` | incremental pull (only changed ROs) |
| `npm run sync -- full` | full backfill of the last 30 days |
