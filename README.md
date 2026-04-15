# AI Job Search Agent

A cloud-based AI agent that searches for jobs, matches them against your resume, tracks applications, and generates cover letters — all running on Cloudflare's edge.

**Stack:** Cloudflare Workers · Workers AI (Llama 3.1) · D1 · Hono · Tailwind

## Features

- 🤖 **AI resume analysis** — extracts skills, experience, and summary
- 🔎 **Multi-source job search** — aggregates Remotive, Arbeitnow, Adzuna, and JSearch (LinkedIn/Indeed)
- 🎯 **Smart matching** — AI scores every job 0–100 with explanation
- ✉️ **AI cover letters** — generated per job, tailored to your resume
- 📋 **Application tracker** — pipeline: saved → applied → interview → offer/rejected

## Deploy via Cloudflare Dashboard (Git Integration)

This is the easiest path — no local wrangler required.

### 1. Create the D1 database

Go to **Cloudflare Dashboard → Workers & Pages → D1** and click **Create database**:

- **Name:** `job-search-db`

Copy the generated **Database ID**.

### 2. Update `wrangler.toml`

In your repo, open `wrangler.toml` and replace `YOUR_D1_DATABASE_ID` with the ID from step 1. Commit and push.

### 3. Initialize the database schema

From the D1 console in the dashboard, go to the **Console** tab and paste the contents of `src/db/schema.sql`, then click **Execute**.

### 4. Connect the GitHub repo

Go to **Workers & Pages → Create → Workers → Import a repository**:

1. Authorize Cloudflare to access your GitHub account
2. Select the repo
3. Set the **Production branch** to the branch you want (e.g. `main`)
4. **Build command:** `npm install`
5. **Deploy command:** `npx wrangler deploy`
6. Click **Save and deploy**

That's it! Every push to the production branch will auto-deploy. Workers AI and D1 bindings are picked up from `wrangler.toml`.

### 5. (Optional) Add job board API keys

For expanded job sources, add these as secrets under **Worker → Settings → Variables & Secrets**:

- `RAPIDAPI_KEY` — for [JSearch](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch) (LinkedIn/Indeed jobs)
- `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` — for [Adzuna](https://developer.adzuna.com/)

Remotive and Arbeitnow work out-of-the-box with no keys.

## Local Development

```bash
npm install
npx wrangler login
npx wrangler d1 create job-search-db
# Paste the returned database_id into wrangler.toml
npm run db:init
npm run dev
```

Open http://localhost:8787.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/dashboard` | Dashboard stats |
| GET | `/api/jobs` | List jobs (filters: sort, min_score, source) |
| POST | `/api/jobs/search` | Search external job boards |
| POST | `/api/jobs/:id/cover-letter` | Generate AI cover letter |
| GET/POST | `/api/resumes` | Manage resumes |
| POST | `/api/resumes/:id/rematch` | Recompute all match scores |
| GET/POST/PATCH | `/api/applications` | Track applications |
| GET/POST | `/api/search/preferences` | Saved search preferences |

## Project Structure

```
src/
├── index.ts              # Hono entry point + dashboard API
├── types.ts              # TypeScript interfaces
├── db/schema.sql         # D1 schema
├── services/
│   ├── ai.ts             # Workers AI (Llama 3.1 + embeddings)
│   ├── jobs.ts           # Job board API aggregator
│   └── matcher.ts        # Resume-job matching pipeline
└── routes/
    ├── jobs.ts
    ├── resumes.ts
    ├── applications.ts
    └── search.ts
public/
└── index.html            # Tailwind dashboard (SPA)
```
