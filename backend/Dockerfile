FROM python:3.14-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY . .

RUN uv sync --frozen --no-dev --no-install-project

ENV PATH="/app/.venv/bin:$PATH"

CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-10000}
