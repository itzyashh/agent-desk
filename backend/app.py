from contextlib import asynccontextmanager
import os
import re
import secrets
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from langgraph.checkpoint.postgres import PostgresSaver
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from psycopg_pool import ConnectionPool
from agent import (
    build_location_tool_messages,
    clear_request_location,
    create_llm_agent,
    create_title_model,
    location_required_in_messages,
    pending_tool_call_ids,
    set_request_location,
)
from google_auth import (
    authorization_url,
    callback_error_html,
    callback_success_html,
    creds_expiry,
    exchange_code,
    google_configured,
)
from google_store import (
    get_connection,
    pop_oauth_state,
    save_oauth_state,
    setup_google_tables,
    upsert_connection,
)
from quota import (
    DEVICE_ID_HEADER,
    client_ip_from_headers,
    daily_token_budget,
    estimate_tokens_from_text,
    get_usage,
    is_valid_device_id,
    quota_key,
    record_usage,
    setup_quota_table,
    snapshot_for,
    tokens_from_title_result,
    tokens_from_turn_messages,
)
from sheets import clear_sheet_context, list_tabs_for_device, set_sheet_context
from swagger_theme_toggle import add_dark_mode_toggle

load_dotenv()

DB_URI = os.getenv("SUPABASE_DB_URI")

checkpointer = None
agent = None
title_model = None
quota_pool: ConnectionPool | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global checkpointer, agent, title_model, quota_pool

    with PostgresSaver.from_conn_string(DB_URI) as checkpointer:
        checkpointer.setup()
        agent = create_llm_agent(checkpointer)
        title_model = create_title_model()
        quota_pool = ConnectionPool(
            conninfo=DB_URI,
            min_size=1,
            max_size=4,
            kwargs={"autocommit": False},
            open=True,
        )
        with quota_pool.connection() as conn:
            setup_quota_table(conn)
            setup_google_tables(conn)
        try:
            yield
        finally:
            if quota_pool is not None:
                quota_pool.close()
                quota_pool = None


app = FastAPI(
    title="Agent Desk API",
    lifespan=lifespan,
    swagger_ui_parameters={
        "syntaxHighlight.theme": "obsidian"
    },
)


CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:4173,http://127.0.0.1:4173",
    ).split(",")
    if origin.strip()
]

# Appwrite Sites default + preview hosts (https://*.appwrite.network).
# Set CORS_ORIGIN_REGEX="" on Render to disable. Add custom domains to CORS_ORIGINS.
_cors_origin_regex = os.getenv(
    "CORS_ORIGIN_REGEX",
    r"https://.*\.appwrite\.network",
).strip()

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_origin_regex=_cors_origin_regex or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    thread_id: str
    new: bool = False
    latitude: float | None = None
    longitude: float | None = None
    spreadsheet_id: str | None = None
    gid: str | None = None


class ChatResponse(BaseModel):
    reply: str
    conversation_name: str | None = None
    needs_location: bool = False
    tokens_used: int | None = None
    tokens_remaining: int | None = None
    daily_token_budget: int | None = None


class QuotaExceededDetail(BaseModel):
    error: str = "daily_token_budget_exceeded"
    message: str
    tokens_used: int
    tokens_remaining: int
    daily_token_budget: int


class GoogleSheetLinkRequest(BaseModel):
    spreadsheet_id: str
    gid: str | None = None


SHEET_ID_RE = re.compile(r"^[a-zA-Z0-9-_]{20,}$")
GID_VALUE_RE = re.compile(r"^\d+$")
SHEET_URL_RE = re.compile(
    r"https?://docs\.google\.com/spreadsheets/d/(?!e/)([a-zA-Z0-9-_]{20,})",
    re.I,
)
GID_RE = re.compile(r"[?&#]gid=(\d+)")


@app.get("/")
def root():
    return {"status": "ok", "message": "Agent Desk API is running"}


def _repair_pending_location_calls(
    config: dict,
    latitude: float | None,
    longitude: float | None,
) -> None:
    """Resolve dangling tool_calls left from a previous needs_location turn."""
    if latitude is None or longitude is None:
        return

    state = agent.get_state(config)
    values = getattr(state, "values", None) or {}
    messages = values.get("messages") or []
    pending = pending_tool_call_ids(messages)
    if not pending:
        return

    tool_messages = build_location_tool_messages(pending, latitude, longitude)
    agent.update_state(config, {"messages": tool_messages})


def _resolve_client(request: Request) -> tuple[str, str, str]:
    device_id = request.headers.get(DEVICE_ID_HEADER)
    if not is_valid_device_id(device_id):
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_device_id",
                "message": f"Missing or invalid {DEVICE_ID_HEADER} header (UUID required).",
            },
        )
    assert device_id is not None
    device_id = device_id.strip()
    ip = client_ip_from_headers(
        x_forwarded_for=request.headers.get("x-forwarded-for"),
        x_real_ip=request.headers.get("x-real-ip"),
        fallback=request.client.host if request.client else None,
    )
    return ip, device_id, quota_key(ip, device_id)


def _quota_response_fields(snapshot) -> dict:
    return {
        "tokens_used": snapshot.tokens_used,
        "tokens_remaining": snapshot.tokens_remaining,
        "daily_token_budget": snapshot.daily_token_budget,
    }


def _enforce_budget(key: str) -> None:
    if quota_pool is None:
        raise HTTPException(status_code=503, detail="Quota store unavailable")
    budget = daily_token_budget()
    with quota_pool.connection() as conn:
        used = get_usage(conn, key=key)
    if used >= budget:
        snapshot = snapshot_for(used, budget=budget)
        raise HTTPException(
            status_code=429,
            detail=QuotaExceededDetail(
                message=(
                    "Daily token budget reached. Try again tomorrow "
                    f"(UTC day, {budget:,} tokens)."
                ),
                tokens_used=snapshot.tokens_used,
                tokens_remaining=snapshot.tokens_remaining,
                daily_token_budget=snapshot.daily_token_budget,
            ).model_dump(),
        )


def _record_turn_usage(
    *,
    key: str,
    ip: str,
    device_id: str,
    messages: list,
    user_message: str,
    title_tokens: int = 0,
) -> dict:
    if quota_pool is None:
        raise HTTPException(status_code=503, detail="Quota store unavailable")

    turn_tokens = tokens_from_turn_messages(messages)
    if turn_tokens <= 0:
        # Fallback if provider omitted usage metadata on this turn.
        assistant_bits = []
        for message in messages:
            content = getattr(message, "content", None)
            if isinstance(content, str):
                assistant_bits.append(content)
        turn_tokens = estimate_tokens_from_text(user_message, *assistant_bits)

    with quota_pool.connection() as conn:
        snapshot = record_usage(
            conn,
            key=key,
            ip=ip,
            device_id=device_id,
            tokens=turn_tokens + max(0, title_tokens),
        )
    return _quota_response_fields(snapshot)


def _parse_sheet_from_text(text: str) -> tuple[str | None, str | None]:
    match = SHEET_URL_RE.search(text)
    if not match:
        return None, None
    gid_match = GID_RE.search(text)
    return match.group(1), gid_match.group(1) if gid_match else None


def _require_quota_pool() -> ConnectionPool:
    if quota_pool is None:
        raise HTTPException(status_code=503, detail="Store unavailable")
    return quota_pool


@app.get("/auth/google/start")
def google_start(device_id: str, spreadsheet_id: str | None = None):
    if not google_configured():
        raise HTTPException(
            status_code=503,
            detail="Google OAuth is not configured",
        )
    if not is_valid_device_id(device_id):
        raise HTTPException(status_code=400, detail="Invalid device_id")
    if spreadsheet_id and not SHEET_ID_RE.fullmatch(spreadsheet_id):
        raise HTTPException(status_code=400, detail="Invalid spreadsheet_id")

    pool = _require_quota_pool()
    state = secrets.token_urlsafe(32)
    auth_url, code_verifier = authorization_url(state)
    with pool.connection() as conn:
        save_oauth_state(
            conn,
            state=state,
            device_id=device_id.strip(),
            spreadsheet_id=spreadsheet_id,
            code_verifier=code_verifier,
        )
    return RedirectResponse(auth_url, status_code=302)


@app.get("/auth/google/callback")
def google_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    if error:
        return HTMLResponse(callback_error_html(error), status_code=400)
    if not code or not state:
        return HTMLResponse(
            callback_error_html("Missing OAuth code. Try connecting again."),
            status_code=400,
        )

    pool = _require_quota_pool()
    with pool.connection() as conn:
        popped = pop_oauth_state(conn, state)
        if not popped:
            return HTMLResponse(
                callback_error_html("Invalid or expired sign-in. Try again."),
                status_code=400,
            )
        device_id, spreadsheet_id, code_verifier = popped
        try:
            creds = exchange_code(code, code_verifier)
        except Exception as exc:
            return HTMLResponse(callback_error_html(str(exc)), status_code=400)

        refresh_token = creds.refresh_token
        if not refresh_token:
            existing = get_connection(conn, device_id)
            refresh_token = existing.refresh_token if existing else None
        if not refresh_token:
            return HTMLResponse(
                callback_error_html(
                    "Google did not return a refresh token. Try connecting again."
                ),
                status_code=400,
            )

        upsert_connection(
            conn,
            device_id=device_id,
            refresh_token=refresh_token,
            token=creds.token,
            token_expiry=creds_expiry(creds),
            spreadsheet_id=None,
        )

    return HTMLResponse(callback_success_html(spreadsheet_id=spreadsheet_id))


@app.get("/auth/google/status")
def google_status(request: Request):
    _, device_id, _ = _resolve_client(request)
    pool = _require_quota_pool()
    with pool.connection() as conn:
        row = get_connection(conn, device_id)
    return {
        "connected": row is not None,
    }


@app.get("/auth/google/tabs")
def google_tabs(request: Request, spreadsheet_id: str | None = None):
    _, device_id, _ = _resolve_client(request)
    if spreadsheet_id and not SHEET_ID_RE.fullmatch(spreadsheet_id):
        raise HTTPException(status_code=400, detail="Invalid spreadsheet_id")
    pool = _require_quota_pool()
    result = list_tabs_for_device(
        pool=pool,
        device_id=device_id,
        spreadsheet_id=spreadsheet_id,
    )
    if result.get("error") == "google_not_connected":
        raise HTTPException(status_code=401, detail="Google is not connected")
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result.get("message") or "Failed to list tabs")
    return result


@app.post("/auth/google/sheet")
def google_sheet(request: Request, body: GoogleSheetLinkRequest):
    _, device_id, _ = _resolve_client(request)
    if not SHEET_ID_RE.fullmatch(body.spreadsheet_id):
        raise HTTPException(status_code=400, detail="Invalid spreadsheet_id")
    if body.gid and not GID_VALUE_RE.fullmatch(body.gid):
        raise HTTPException(status_code=400, detail="Invalid gid")

    pool = _require_quota_pool()
    with pool.connection() as conn:
        row = get_connection(conn, device_id)
        if row is None:
            raise HTTPException(
                status_code=401,
                detail="Google is not connected",
            )
    return {
        "connected": True,
        "spreadsheet_id": body.spreadsheet_id,
        "gid": body.gid,
    }


@app.post("/chat", response_model=ChatResponse)
def chat(request: Request, body: ChatRequest):
    ip, device_id, key = _resolve_client(request)
    _enforce_budget(key)

    config = {"configurable": {"thread_id": body.thread_id}}
    set_request_location(body.latitude, body.longitude)

    parsed_id, parsed_gid = _parse_sheet_from_text(body.message)
    spreadsheet_id = body.spreadsheet_id or parsed_id
    gid = body.gid or parsed_gid
    pool = _require_quota_pool()

    set_sheet_context(
        device_id=device_id,
        spreadsheet_id=spreadsheet_id,
        gid=gid,
        pool=pool,
    )

    message = body.message
    if body.latitude is not None and body.longitude is not None:
        message = (
            f"{body.message}\n\n"
            f"[device_location] latitude={body.latitude} "
            f"longitude={body.longitude}\n"
            "Use these coordinates now. Call get_weather if needed. "
            "Do not ask the user for coordinates."
        )

    try:
        _repair_pending_location_calls(config, body.latitude, body.longitude)
        response = agent.invoke(
            {"messages": [{"role": "user", "content": message}]},
            config,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        clear_request_location()
        clear_sheet_context()

    messages = response["messages"]
    # Only treat as needs_location when we did not already receive coords
    needs_location = (
        body.latitude is None
        and body.longitude is None
        and location_required_in_messages(messages)
    )

    if needs_location:
        quota_fields = _record_turn_usage(
            key=key,
            ip=ip,
            device_id=device_id,
            messages=messages,
            user_message=body.message,
        )
        return ChatResponse(
            reply="",
            conversation_name=None,
            needs_location=True,
            **quota_fields,
        )

    reply = messages[-1].content
    if not isinstance(reply, str):
        reply = str(reply)

    conversation_name = None
    title_tokens = 0
    if body.new:
        title = title_model.invoke(
            [
                {
                    "role": "system",
                    "content": (
                        "Generate a short sidebar title for this chat. "
                        "Use 3-6 words, no quotes, no trailing punctuation."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"User message: {body.message}\n"
                        f"Assistant reply: {reply}"
                    ),
                },
            ]
        )
        conversation_name = title.conversation_name
        title_tokens = tokens_from_title_result(title)

    quota_fields = _record_turn_usage(
        key=key,
        ip=ip,
        device_id=device_id,
        messages=messages,
        user_message=body.message,
        title_tokens=title_tokens,
    )

    return ChatResponse(
        reply=reply,
        conversation_name=conversation_name,
        needs_location=False,
        **quota_fields,
    )


add_dark_mode_toggle(app, default_theme="dark")
