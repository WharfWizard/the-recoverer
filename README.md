# The Recoverer™

Get SAFE · Academy of Life Planning

A citizen-investigator empowerment tool for people who have lost money to
investment fraud: build an evidence dossier, draft professional reports to
the firm, your bank, and the authorities, and see honestly which recovery
routes are realistic — before you consider handing your case to anyone else.

This is a working prototype, not a finished production system. It's built
to deploy cleanly on Vercel today, with the known gaps below called out
rather than hidden.

## Stack

- **Frontend:** vanilla HTML/CSS/JS, no framework or build step — same
  approach as Investigator™. Files live in `public/`.
- **Backend:** a single Vercel serverless function, `api/claude.js`, that
  proxies calls to the Anthropic API. The API key lives only in Vercel's
  environment variables — it is never sent to, or visible from, the browser.
- **AI:** Anthropic Claude API (`claude-sonnet-4-6`, fixed server-side).
- **PDF generation:** jsPDF, client-side only. It never calls Claude — it
  only formats data already held in the browser. Built-in Helvetica font,
  no images embedded, to keep files small.
- **Persistence (current):** the browser's own `localStorage` — works
  immediately, no external account needed, but is per-browser/per-device
  only. See "Known gaps" below.

## Deploying to Vercel

You'll need a GitHub repo and a Vercel account connected to it — I can't do
either of those steps for you, but here's exactly what to do:

1. **Push this folder to a new GitHub repo**, e.g. `WharfWizard/the-recoverer`,
   matching the naming convention used by Goliathon, The Leveller™, and
   Investigator™.
   ```
   git init
   git add .
   git commit -m "Initial commit — The Recoverer prototype"
   git branch -M main
   git remote add origin https://github.com/WharfWizard/the-recoverer.git
   git push -u origin main
   ```
2. **Import the repo into Vercel** (vercel.com → Add New → Project → import
   from GitHub). Framework preset: **Other** — no build step is needed.
3. **Add the environment variable**: Project → Settings → Environment
   Variables → add `ANTHROPIC_API_KEY` with your Anthropic API key. Apply it
   to Production (and Preview, if you want PR previews to work too).
4. **Deploy.** Vercel will pick up `public/` as static files and
   `api/claude.js` as a serverless function automatically.
5. Once live, test the three AI actions (evidence analysis, draft report,
   safeguard check) and the PDF download to confirm the environment
   variable is wired correctly.

### Local development

```
npm install -g vercel   # if you don't already have the CLI
cp .env.example .env    # then fill in your own key
vercel dev
```

## Known gaps before this is a real production system

Flagged deliberately rather than glossed over:

- **Persistence is per-browser (localStorage), not per-account.** The
  product spec calls for Supabase Postgres, matching Goliathon, so a case
  can be picked up on another device or handed to a professional without an
  export step. The current `saveState()` / `loadState()` functions in
  `public/app.js` are written as a single JSON snapshot, which maps
  directly onto one Supabase row — swapping them for API calls to a new
  `api/case.js` endpoint is a contained change, not a rewrite.
- **No auth.** Anyone with the URL and local access to a browser can see
  that browser's case. Fine for a solo prototype; not fine once real cases
  are being handled.
- **No rate limiting on `/api/claude`.** Worth adding (e.g. Vercel's
  built-in rate limiting, or a simple IP/session check) before this is
  publicly linked from a live site, so a bad actor can't run up API costs.
- **The AI-drafted report templates are not yet legally reviewed** — flagged
  in the product spec as a prerequisite before relying on the CRM Code and
  FOS drafts in a real case.
- **Uploaded PDFs/DOCX/MSG files aren't parsed** — only their filename is
  logged; the victim has to type a description manually. Images and plain
  text files are analysed automatically.

## Repository structure

```
├── api/
│   └── claude.js          Serverless proxy to the Anthropic API
├── public/
│   ├── index.html          App shell
│   ├── app.js               All application logic
│   └── styles/
│       └── main.css         All styling
├── package.json
├── vercel.json
├── .env.example
└── .gitignore
```
