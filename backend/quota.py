"""Daily token budget tracking keyed by IP + device ID."""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone

import psycopg
from langchain_core.messages import AIMessage, BaseMessage

DEVICE_ID_HEADER = "X-Device-Id"
DEVICE_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# Soft public-demo default; override with DAILY_TOKEN_BUDGET.
DEFAULT_DAILY_TOKEN_BUDGET = 40_000

_SETUP_SQL = """
CREATE TABLE IF NOT EXISTS chat_usage (
  quota_key TEXT NOT NULL,
  period_date DATE NOT NULL,
  ip TEXT NOT NULL,
  device_id TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (quota_key, period_date)
);
CREATE INDEX IF NOT EXISTS chat_usage_period_date_idx
  ON chat_usage (period_date);
"""


@dataclass(frozen=True)
class QuotaSnapshot:
    tokens_used: int
    tokens_remaining: int
    daily_token_budget: int
    period_date: date


def daily_token_budget() -> int:
    raw = os.getenv("DAILY_TOKEN_BUDGET", str(DEFAULT_DAILY_TOKEN_BUDGET)).strip()
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_DAILY_TOKEN_BUDGET
    return max(0, value)


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def is_valid_device_id(device_id: str | None) -> bool:
    if not device_id:
        return False
    return bool(DEVICE_ID_RE.fullmatch(device_id.strip()))


def client_ip_from_headers(
    *,
    x_forwarded_for: str | None,
    x_real_ip: str | None,
    fallback: str | None,
) -> str:
    if x_forwarded_for:
        first = x_forwarded_for.split(",")[0].strip()
        if first:
            return first
    if x_real_ip and x_real_ip.strip():
        return x_real_ip.strip()
    if fallback and fallback.strip():
        return fallback.strip()
    return "unknown"


def quota_key(ip: str, device_id: str) -> str:
    digest = hashlib.sha256(f"{ip.strip().lower()}|{device_id.strip().lower()}".encode())
    return digest.hexdigest()


def setup_quota_table(conn: psycopg.Connection) -> None:
    conn.execute(_SETUP_SQL)
    conn.commit()


def get_usage(
    conn: psycopg.Connection,
    *,
    key: str,
    period: date | None = None,
) -> int:
    period = period or utc_today()
    row = conn.execute(
        """
        SELECT tokens_used
        FROM chat_usage
        WHERE quota_key = %s AND period_date = %s
        """,
        (key, period),
    ).fetchone()
    return int(row[0]) if row else 0


def snapshot_for(
    tokens_used: int,
    budget: int | None = None,
    period: date | None = None,
) -> QuotaSnapshot:
    budget = daily_token_budget() if budget is None else budget
    used = max(0, tokens_used)
    return QuotaSnapshot(
        tokens_used=used,
        tokens_remaining=max(0, budget - used),
        daily_token_budget=budget,
        period_date=period or utc_today(),
    )


def record_usage(
    conn: psycopg.Connection,
    *,
    key: str,
    ip: str,
    device_id: str,
    tokens: int,
    period: date | None = None,
) -> QuotaSnapshot:
    period = period or utc_today()
    tokens = max(0, int(tokens))
    row = conn.execute(
        """
        INSERT INTO chat_usage (
          quota_key, period_date, ip, device_id, tokens_used, request_count, updated_at
        )
        VALUES (%s, %s, %s, %s, %s, 1, NOW())
        ON CONFLICT (quota_key, period_date) DO UPDATE SET
          tokens_used = chat_usage.tokens_used + EXCLUDED.tokens_used,
          request_count = chat_usage.request_count + 1,
          ip = EXCLUDED.ip,
          device_id = EXCLUDED.device_id,
          updated_at = NOW()
        RETURNING tokens_used
        """,
        (key, period, ip, device_id, tokens),
    ).fetchone()
    conn.commit()
    used = int(row[0]) if row else tokens
    return snapshot_for(used, period=period)


def _usage_from_message(message: BaseMessage | dict) -> int:
    metadata = None
    if isinstance(message, dict):
        metadata = message.get("usage_metadata")
        if not metadata:
            response_metadata = message.get("response_metadata") or {}
            token_usage = response_metadata.get("token_usage") or response_metadata.get(
                "usage"
            )
            if isinstance(token_usage, dict):
                total = token_usage.get("total_tokens")
                if total is not None:
                    return int(total)
                prompt = int(token_usage.get("prompt_tokens") or 0)
                completion = int(token_usage.get("completion_tokens") or 0)
                return prompt + completion
    else:
        metadata = getattr(message, "usage_metadata", None)
        if not metadata:
            response_metadata = getattr(message, "response_metadata", None) or {}
            token_usage = response_metadata.get("token_usage") or response_metadata.get(
                "usage"
            )
            if isinstance(token_usage, dict):
                total = token_usage.get("total_tokens")
                if total is not None:
                    return int(total)
                prompt = int(token_usage.get("prompt_tokens") or 0)
                completion = int(token_usage.get("completion_tokens") or 0)
                return prompt + completion

    if not metadata:
        return 0
    if isinstance(metadata, dict):
        total = metadata.get("total_tokens")
        if total is not None:
            return int(total)
        return int(metadata.get("input_tokens") or 0) + int(
            metadata.get("output_tokens") or 0
        )
    total = getattr(metadata, "total_tokens", None)
    if total is not None:
        return int(total)
    return int(getattr(metadata, "input_tokens", 0) or 0) + int(
        getattr(metadata, "output_tokens", 0) or 0
    )


def _is_human_message(message: BaseMessage | dict) -> bool:
    if isinstance(message, dict):
        return message.get("role") == "user" or message.get("type") == "human"
    return getattr(message, "type", None) == "human"


def _is_ai_message(message: BaseMessage | dict) -> bool:
    if isinstance(message, AIMessage):
        return True
    if isinstance(message, dict):
        return message.get("role") == "assistant" or message.get("type") == "ai"
    return getattr(message, "type", None) == "ai"


def tokens_from_turn_messages(messages: list) -> int:
    """Sum token usage for AI messages after the latest human message."""
    if not messages:
        return 0

    start = 0
    for i in range(len(messages) - 1, -1, -1):
        if _is_human_message(messages[i]):
            start = i + 1
            break

    total = 0
    for message in messages[start:]:
        if _is_ai_message(message):
            total += _usage_from_message(message)
    return total


def estimate_tokens_from_text(*parts: str) -> int:
    """Rough fallback when provider usage metadata is missing (~4 chars/token)."""
    length = sum(len(part or "") for part in parts)
    return max(1, (length + 3) // 4)


def tokens_from_title_result(result) -> int:
    raw = getattr(result, "raw", None)
    if raw is not None:
        usage = _usage_from_message(raw)
        if usage:
            return usage
    # Structured output may wrap the message differently.
    for attr in ("response_metadata", "usage_metadata"):
        if hasattr(result, attr):
            usage = _usage_from_message(result)
            if usage:
                return usage
    name = getattr(result, "conversation_name", None) or ""
    return estimate_tokens_from_text(str(name), "title")
