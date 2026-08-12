# Agent Desk — backend

FastAPI + LangGraph LLM agent API.

## Local (dev)

```bash
cp .env.example .env   # first time — fill keys
uv sync
uv run uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Uses `backend/.env`. CORS defaults allow `http://localhost:3000`.

## Production

Deployed on Render. Set the same keys in the Render dashboard (`OPENAI_API_KEY`, `OPENWEATHER_API_KEY`, `SUPABASE_DB_URI`, `CORS_ORIGINS`).
