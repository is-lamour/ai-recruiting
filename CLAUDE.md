# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the project

**Prerequisites:** Python with pip, `.env` file with `GEMINI_API_KEY` (copy from `.env.example`).

```bash
# Install dependencies
pip install -r backend/requirements.txt

# Start the backend server (http://localhost:8000)
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload

# Or use the convenience script from the project root (Windows)
start.bat
```

**Test Gemini API connectivity:**
```bash
python test_gemini.py
```

There are no automated tests in this project.

## Architecture

The project has two independent parts that communicate over HTTP:

### Backend (`backend/`)

FastAPI server with SQLite storage. Three modules:

- **`main.py`** — all HTTP routes. Mounts `/static` for the dashboard UI. Handles vacancies CRUD, candidate screening, Excel export, and "pending actions" (queued rejections/Huntflow sends).
- **`ai.py`** — Gemini API wrapper. `summarize_vacancy()` compresses vacancy text to ≤700 chars; `screen_resume()` scores a resume 0–100 and returns `{score, category, comment, questions, summary}`. Uses `gemini-2.5-flash-lite` for both. Category thresholds: `suitable` ≥80, `consider` 66–79, `reject` <66.
- **`database.py`** — SQLite helpers. DB file lives at `backend/screening.db`. Two tables: `vacancies` and `candidates`. Includes inline migration for columns added after initial release.

The dashboard UI (`backend/static/`) is a plain HTML/JS/CSS single-page app served directly by FastAPI.

### Chrome Extension (`extension/`)

Manifest V3 extension targeting hh.kz. Three-layer architecture:

- **`popup.js`** — the extension popup UI. Manages vacancy selection, triggers screening, shows progress, and initiates bulk rejections/Huntflow sends.
- **`content.js`** — injected into hh.kz pages. Does the actual work: collects resume links from the DOM (handles pagination up to 20 pages), fetches each resume HTML via `fetch` with `credentials: include`, extracts text, and POSTs to the backend `/api/screen`. Sends progress updates via `chrome.storage.session`. Also handles automated rejections by clicking the HH "discard" button in the DOM.
- **`background.js`** (service worker) — CORS proxy between content script and backend. Content script cannot call `localhost:8000` directly due to CSP, so it sends messages (`api_get`, `api_post`, `api_patch`) to background which makes the actual fetch. Also relays `chrome.storage.session` reads for cancel/progress state.

### Key data flow

1. User selects a vacancy in popup → content script collects all resume URLs from the current hh.kz responses page
2. For each URL: content script fetches the resume page (authenticated via hh.kz session cookies), extracts text, POSTs to `POST /api/screen`
3. Backend calls `ai.screen_resume()` → stores result in SQLite
4. Dashboard at `http://localhost:8000` shows all candidates grouped by category with AI comments and gap questions
5. Recruiter marks candidates → bulk reject (content script clicks HH UI) or bulk send to Huntflow (opens tabs)

### Candidate statuses

`new` → `to_reject` / `to_huntflow` → `rejected` / `huntflow_sent`
