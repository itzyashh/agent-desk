# Agent Desk — backend

FastAPI + LangGraph LLM agent API.

## Local (dev)

```bash
cp .env.example .env   # first time — fill keys
uv sync
uv run uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Uses `backend/.env`. CORS defaults allow `http://localhost:3000` and `https://*.appwrite.network`.

## Production

Deployed on Render. Set the same keys in the Render dashboard (`OPENAI_API_KEY`, `OPENWEATHER_API_KEY`, `SUPABASE_DB_URI`, `CORS_ORIGINS`).

For the Appwrite-hosted frontend, either rely on the default `CORS_ORIGIN_REGEX` (`https://.*\.appwrite\.network`) after deploy, or add the exact site origin to `CORS_ORIGINS` (e.g. `https://your-site.appwrite.network`). Custom domains must go in `CORS_ORIGINS`.
