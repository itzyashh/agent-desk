# Agent Desk

LLM agent API and chat workspace.

## Structure

- `backend/` — FastAPI + LangGraph agent API
- `frontend/` — TanStack / Vite chat UI

## Backend

```bash
cd backend
uv sync
uv run uvicorn app:app --reload --port 8000
```

Requires a `backend/.env` with `SUPABASE_DB_URI` (and any LLM keys your agent uses).

## Frontend

```bash
cd frontend
yarn
yarn dev
```

Opens at http://localhost:3000 and talks to http://localhost:8000.
