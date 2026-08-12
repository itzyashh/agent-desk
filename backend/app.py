from contextlib import asynccontextmanager
import os
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from langgraph.checkpoint.postgres import PostgresSaver
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from agent import (
    build_location_tool_messages,
    clear_request_location,
    create_llm_agent,
    create_title_model,
    location_required_in_messages,
    pending_tool_call_ids,
    set_request_location,
)
from swagger_theme_toggle import add_dark_mode_toggle

load_dotenv()

DB_URI = os.getenv("SUPABASE_DB_URI")

checkpointer = None
agent = None
title_model = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global checkpointer, agent, title_model

    with PostgresSaver.from_conn_string(DB_URI) as checkpointer:
        checkpointer.setup()
        agent = create_llm_agent(checkpointer)
        title_model = create_title_model()
        yield


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
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
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


class ChatResponse(BaseModel):
    reply: str
    conversation_name: str | None = None
    needs_location: bool = False


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


@app.post("/chat", response_model=ChatResponse)
def chat(body: ChatRequest):
    config = {"configurable": {"thread_id": body.thread_id}}
    set_request_location(body.latitude, body.longitude)

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

    messages = response["messages"]
    # Only treat as needs_location when we did not already receive coords
    needs_location = (
        body.latitude is None
        and body.longitude is None
        and location_required_in_messages(messages)
    )

    if needs_location:
        return ChatResponse(
            reply="",
            conversation_name=None,
            needs_location=True,
        )

    reply = messages[-1].content
    if not isinstance(reply, str):
        reply = str(reply)

    conversation_name = None
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

    return ChatResponse(
        reply=reply,
        conversation_name=conversation_name,
        needs_location=False,
    )


add_dark_mode_toggle(app, default_theme="dark")
