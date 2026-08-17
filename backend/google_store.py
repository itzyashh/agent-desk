"""Persist Google OAuth tokens and CSRF state per device."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import psycopg

_SETUP_SQL = """
CREATE TABLE IF NOT EXISTS google_connections (
  device_id TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  token TEXT,
  token_expiry TIMESTAMPTZ,
  spreadsheet_id TEXT,
  gid TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS google_oauth_states (
  state TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  spreadsheet_id TEXT,
  code_verifier TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

_MIGRATE_SQL = """
ALTER TABLE google_oauth_states
  ADD COLUMN IF NOT EXISTS code_verifier TEXT;
ALTER TABLE google_connections
  ADD COLUMN IF NOT EXISTS gid TEXT;
"""

OAUTH_STATE_TTL_MINUTES = 15


@dataclass(frozen=True)
class GoogleConnection:
    device_id: str
    refresh_token: str
    token: str | None
    token_expiry: datetime | None
    spreadsheet_id: str | None
    gid: str | None = None


def setup_google_tables(conn: psycopg.Connection) -> None:
    conn.execute(_SETUP_SQL)
    conn.execute(_MIGRATE_SQL)
    conn.commit()


def save_oauth_state(
    conn: psycopg.Connection,
    *,
    state: str,
    device_id: str,
    spreadsheet_id: str | None,
    code_verifier: str | None,
) -> None:
    conn.execute(
        """
        INSERT INTO google_oauth_states (
          state, device_id, spreadsheet_id, code_verifier
        )
        VALUES (%s, %s, %s, %s)
        """,
        (state, device_id, spreadsheet_id, code_verifier),
    )
    conn.commit()


def pop_oauth_state(
    conn: psycopg.Connection,
    state: str,
) -> tuple[str, str | None, str | None] | None:
    conn.execute(
        f"""
        DELETE FROM google_oauth_states
        WHERE created_at < NOW() - INTERVAL '{OAUTH_STATE_TTL_MINUTES} minutes'
        """
    )
    row = conn.execute(
        """
        DELETE FROM google_oauth_states
        WHERE state = %s
        RETURNING device_id, spreadsheet_id, code_verifier
        """,
        (state,),
    ).fetchone()
    conn.commit()
    if not row:
        return None
    device_id, spreadsheet_id, code_verifier = row
    return (
        str(device_id),
        str(spreadsheet_id) if spreadsheet_id else None,
        str(code_verifier) if code_verifier else None,
    )


def get_connection(
    conn: psycopg.Connection,
    device_id: str,
) -> GoogleConnection | None:
    row = conn.execute(
        """
        SELECT device_id, refresh_token, token, token_expiry, spreadsheet_id, gid
        FROM google_connections
        WHERE device_id = %s
        """,
        (device_id,),
    ).fetchone()
    if not row:
        return None
    return GoogleConnection(
        device_id=str(row[0]),
        refresh_token=str(row[1]),
        token=str(row[2]) if row[2] else None,
        token_expiry=row[3],
        spreadsheet_id=str(row[4]) if row[4] else None,
        gid=str(row[5]) if len(row) > 5 and row[5] else None,
    )


def upsert_connection(
    conn: psycopg.Connection,
    *,
    device_id: str,
    refresh_token: str,
    token: str | None,
    token_expiry: datetime | None,
    spreadsheet_id: str | None,
) -> GoogleConnection:
    conn.execute(
        """
        INSERT INTO google_connections (
          device_id, refresh_token, token, token_expiry, spreadsheet_id, updated_at
        )
        VALUES (%s, %s, %s, %s, %s, NOW())
        ON CONFLICT (device_id) DO UPDATE SET
          refresh_token = COALESCE(EXCLUDED.refresh_token, google_connections.refresh_token),
          token = EXCLUDED.token,
          token_expiry = EXCLUDED.token_expiry,
          spreadsheet_id = COALESCE(
            EXCLUDED.spreadsheet_id, google_connections.spreadsheet_id
          ),
          updated_at = NOW()
        """,
        (device_id, refresh_token, token, token_expiry, spreadsheet_id),
    )
    conn.commit()
    saved = get_connection(conn, device_id)
    assert saved is not None
    return saved


def update_tokens(
    conn: psycopg.Connection,
    *,
    device_id: str,
    token: str | None,
    token_expiry: datetime | None,
    refresh_token: str | None = None,
) -> None:
    conn.execute(
        """
        UPDATE google_connections
        SET
          token = %s,
          token_expiry = %s,
          refresh_token = COALESCE(%s, refresh_token),
          updated_at = NOW()
        WHERE device_id = %s
        """,
        (token, token_expiry, refresh_token, device_id),
    )
    conn.commit()


def update_spreadsheet_id(
    conn: psycopg.Connection,
    *,
    device_id: str,
    spreadsheet_id: str,
    gid: str | None = None,
) -> GoogleConnection | None:
    conn.execute(
        """
        UPDATE google_connections
        SET spreadsheet_id = %s, gid = %s, updated_at = NOW()
        WHERE device_id = %s
        """,
        (spreadsheet_id, gid, device_id),
    )
    conn.commit()
    return get_connection(conn, device_id)


def expiry_to_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
