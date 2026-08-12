from contextlib import asynccontextmanager
import os
from dotenv import load_dotenv
from fastapi import FastAPI
from langgraph.checkpoint.postgres import PostgresSaver
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from agent import create_llm_agent, create_title_model
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
    }        
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
    
class ChatResponse(BaseModel):
    reply: str
    conversation_name: str | None = None
    
@app.get('/')
def root():
    return {"status": "ok", "message": "Agent Desk API is running"}

@app.post("/chat", response_model=ChatResponse)
def chat(body: ChatRequest):
    response = agent.invoke(
        {"messages": [{"role": "user", "content": body.message}]},
        {"configurable": {"thread_id": body.thread_id}},
    )
    reply = response["messages"][-1].content
    
    conversation_name = None
    if body.new:
        title = title_model.invoke([
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
        ])
        conversation_name = title.conversation_name
        
    return ChatResponse(reply=reply, conversation_name=conversation_name)
 
    
add_dark_mode_toggle(app, default_theme="dark")
