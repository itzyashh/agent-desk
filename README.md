# Agent Desk

LLM agent API and chat workspace.

## Structure

- `backend/` — FastAPI + LangGraph agent API
- `frontend/` — TanStack / Vite chat UI

## Environments

| Mode | Frontend command | API URL |
|------|------------------|---------|
| **Dev** | `yarn dev` | `http://localhost:8000` (from `.env.development`) |
| **Prod** | `yarn build` | `https://agent-desk.onrender.com` (from `.env.production`) |

Local UI never waits on Render — run the backend locally.

## Local development (two terminals)

**1. Backend**

```bash
cd backend
# first time: cp .env.example .env  and fill keys
uv sync
uv run uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

API: http://localhost:8000 — docs at http://localhost:8000/docs

**2. Frontend**

```bash
cd frontend
yarn
yarn dev
```

UI: http://localhost:3000 → talks to local backend via `VITE_API_URL`.

## Production

- Backend: Render (`agent-desk.onrender.com`) with its dashboard env vars
- Frontend: build with production env baked in:

```bash
cd frontend
yarn build
```

Override API URL temporarily without editing files:

```bash
# frontend against Render while developing UI
VITE_API_URL=https://agent-desk.onrender.com yarn dev

# frontend against local backend (default in .env.development)
VITE_API_URL=http://localhost:8000 yarn dev
```
