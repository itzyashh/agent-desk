"""Google OAuth helpers for connecting a device to Sheets."""

from __future__ import annotations

import html
import json
import os
from datetime import datetime, timezone
from urllib.parse import quote

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

from google_store import GoogleConnection

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
TOKEN_URI = "https://oauth2.googleapis.com/token"
AUTH_URI = "https://accounts.google.com/o/oauth2/auth"


def google_client_id() -> str:
    return (os.getenv("GOOGLE_CLIENT_ID") or "").strip()


def google_client_secret() -> str:
    return (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()


def google_redirect_uri() -> str:
    return (
        os.getenv("GOOGLE_REDIRECT_URI") or "http://localhost:8000/auth/google/callback"
    ).strip()


def _allow_local_http() -> None:
    uri = google_redirect_uri()
    if uri.startswith("http://localhost") or uri.startswith("http://127.0.0.1"):
        os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")


def frontend_url() -> str:
    return (os.getenv("FRONTEND_URL") or "http://localhost:3000").rstrip("/")


def google_configured() -> bool:
    return bool(google_client_id() and google_client_secret())


def _client_config() -> dict:
    return {
        "web": {
            "client_id": google_client_id(),
            "client_secret": google_client_secret(),
            "auth_uri": AUTH_URI,
            "token_uri": TOKEN_URI,
            "redirect_uris": [google_redirect_uri()],
        }
    }


def build_flow() -> Flow:
    _allow_local_http()
    return Flow.from_client_config(
        _client_config(),
        scopes=SCOPES,
        redirect_uri=google_redirect_uri(),
    )


def authorization_url(state: str) -> tuple[str, str]:
    flow = build_flow()
    url, _ = flow.authorization_url(
        access_type="offline",
        prompt="consent",
        state=state,
    )
    if not flow.code_verifier:
        raise RuntimeError("OAuth PKCE verifier was not generated")
    return url, flow.code_verifier


def exchange_code(code: str, code_verifier: str | None = None) -> Credentials:
    os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")
    _allow_local_http()
    flow = Flow.from_client_config(
        _client_config(),
        scopes=SCOPES,
        redirect_uri=google_redirect_uri(),
        code_verifier=code_verifier,
        autogenerate_code_verifier=False,
    )
    flow.fetch_token(code=code)
    return flow.credentials


def credentials_from_connection(row: GoogleConnection) -> Credentials:
    return Credentials(
        token=row.token,
        refresh_token=row.refresh_token,
        token_uri=TOKEN_URI,
        client_id=google_client_id(),
        client_secret=google_client_secret(),
        scopes=SCOPES,
        expiry=row.token_expiry.replace(tzinfo=None) if row.token_expiry else None,
    )


def refresh_credentials(creds: Credentials) -> Credentials:
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
    return creds


def creds_expiry(creds: Credentials) -> datetime | None:
    expiry = getattr(creds, "expiry", None)
    if expiry is None:
        return None
    if expiry.tzinfo is None:
        return expiry.replace(tzinfo=timezone.utc)
    return expiry.astimezone(timezone.utc)


def callback_success_html(*, spreadsheet_id: str | None) -> str:
    origin = frontend_url()
    payload = json.dumps(
        {"type": "google-connected", "spreadsheetId": spreadsheet_id}
    )
    redirect = f"{origin}/?google=connected"
    if spreadsheet_id:
        redirect = f"{redirect}&spreadsheet_id={quote(spreadsheet_id)}"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Google connected</title>
  <style>
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #1a1a1a;
      color: #ececec;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }}
    p {{ color: #9b9b9b; }}
  </style>
</head>
<body>
  <p>Google connected. You can close this window.</p>
  <script>
    const payload = {payload};
    const target = {json.dumps(origin)};
    if (window.opener && !window.opener.closed) {{
      window.opener.postMessage(payload, target);
      window.close();
    }} else {{
      window.location.replace({json.dumps(redirect)});
    }}
  </script>
</body>
</html>
"""


def callback_error_html(message: str) -> str:
    origin = frontend_url()
    payload = json.dumps({"type": "google-connect-error", "message": message})
    redirect = f"{origin}/?google=error"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Google connect failed</title>
  <style>
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #1a1a1a;
      color: #ececec;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }}
  </style>
</head>
<body>
  <p>{html.escape(message)}</p>
  <script>
    const payload = {payload};
    if (window.opener && !window.opener.closed) {{
      window.opener.postMessage(payload, {json.dumps(origin)});
      window.close();
    }} else {{
      window.location.replace({json.dumps(redirect)});
    }}
  </script>
</body>
</html>
"""
