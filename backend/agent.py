import json
import os
from contextvars import ContextVar

from langchain.agents import create_agent
from langchain_openai import ChatOpenAI
from dotenv import load_dotenv
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import tool
from pydantic import BaseModel, Field

import httpx

load_dotenv()

WEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY")

_request_location: ContextVar[tuple[float, float] | None] = ContextVar(
    "request_location",
    default=None,
)

NEEDS_LOCATION_STATUS = "needs_location"
NEEDS_LOCATION_PAYLOAD = {
    "status": NEEDS_LOCATION_STATUS,
    "message": (
        "Browser location is not available yet. "
        "Stop tool use for this turn; the client will send coordinates next."
    ),
}


class ConversationTitle(BaseModel):
    conversation_name: str = Field(
        description="Short 3-6 word title summarizing the chat topic"
    )


def set_request_location(
    latitude: float | None,
    longitude: float | None,
) -> None:
    if latitude is None or longitude is None:
        _request_location.set(None)
    else:
        _request_location.set((latitude, longitude))


def clear_request_location() -> None:
    _request_location.set(None)


def _parse_content(content):
    if content is None:
        return None
    if isinstance(content, dict):
        return content
    if isinstance(content, str):
        try:
            parsed = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _message_indicates_needs_location(content) -> bool:
    parsed = _parse_content(content)
    if parsed is None:
        return False
    return parsed.get("status") == NEEDS_LOCATION_STATUS


def _message_content(message):
    if isinstance(message, dict):
        return message.get("content")
    return getattr(message, "content", None)


def _is_human_message(message) -> bool:
    if isinstance(message, dict):
        return message.get("role") == "user" or message.get("type") == "human"
    msg_type = getattr(message, "type", None)
    return msg_type == "human"


def location_required_in_messages(messages) -> bool:
    """Only inspect the current turn (after the latest human message)."""
    if not messages:
        return False

    start = 0
    for i in range(len(messages) - 1, -1, -1):
        if _is_human_message(messages[i]):
            start = i + 1
            break

    for message in messages[start:]:
        if _message_indicates_needs_location(_message_content(message)):
            return True

    return False


def _tool_call_id(tool_call) -> str | None:
    if isinstance(tool_call, dict):
        return tool_call.get("id")
    return getattr(tool_call, "id", None)


def _tool_call_name(tool_call) -> str | None:
    if isinstance(tool_call, dict):
        return tool_call.get("name") or tool_call.get("function", {}).get("name")
    return getattr(tool_call, "name", None)


def pending_tool_call_ids(messages) -> list[tuple[str, str | None]]:
    """Return (tool_call_id, tool_name) pairs that lack a ToolMessage response."""
    answered: set[str] = set()
    for message in messages:
        if isinstance(message, ToolMessage):
            tool_call_id = getattr(message, "tool_call_id", None)
            if tool_call_id:
                answered.add(tool_call_id)
        elif isinstance(message, dict) and (
            message.get("role") == "tool" or message.get("type") == "tool"
        ):
            tool_call_id = message.get("tool_call_id")
            if tool_call_id:
                answered.add(tool_call_id)

    unresolved: list[tuple[str, str | None]] = []
    for message in messages:
        tool_calls = None
        if isinstance(message, AIMessage):
            tool_calls = message.tool_calls or []
        elif isinstance(message, dict) and (
            message.get("role") == "assistant" or message.get("type") == "ai"
        ):
            tool_calls = message.get("tool_calls") or []
        if not tool_calls:
            continue
        for tool_call in tool_calls:
            tool_call_id = _tool_call_id(tool_call)
            if tool_call_id and tool_call_id not in answered:
                unresolved.append((tool_call_id, _tool_call_name(tool_call)))

    return unresolved


def build_location_tool_messages(
    pending: list[tuple[str, str | None]],
    latitude: float,
    longitude: float,
) -> list[ToolMessage]:
    content = json.dumps(
        {
            "latitude": str(latitude),
            "longitude": str(longitude),
        }
    )
    messages: list[ToolMessage] = []
    for tool_call_id, tool_name in pending:
        if tool_name and tool_name != "get_location":
            messages.append(
                ToolMessage(
                    content=json.dumps(
                        {
                            "error": (
                                "Tool skipped until browser location was provided"
                            )
                        }
                    ),
                    tool_call_id=tool_call_id,
                    name=tool_name,
                )
            )
        else:
            messages.append(
                ToolMessage(
                    content=content,
                    tool_call_id=tool_call_id,
                    name=tool_name or "get_location",
                )
            )
    return messages


@tool
def get_weather(latitude: str, longitude: str):
    """Get weather for a given latitude and longitude"""
    if not WEATHER_API_KEY:
        return "OpenWeather API key not found"

    response = httpx.get(
        "https://api.openweathermap.org/data/2.5/weather",
        params={
            "lat": latitude,
            "lon": longitude,
            "appid": WEATHER_API_KEY,
            "units": "metric",
        },
    )
    response.raise_for_status()
    data = response.json()
    return data


@tool
def get_location():
    """Get the user's current browser coordinates.

    Call this when the user asks about weather or location without naming a city.
    If this returns status=needs_location, end the turn.
    On a later turn, if the user (or client) provides coordinates, call get_location
    again or use the provided latitude/longitude with get_weather.
    """
    coords = _request_location.get()
    if coords is None:
        return NEEDS_LOCATION_PAYLOAD

    latitude, longitude = coords
    return {
        "latitude": str(latitude),
        "longitude": str(longitude),
    }


def create_llm_agent(checkpointer):
    model = ChatOpenAI(model="gpt-4o-mini")
    return create_agent(
        model,
        tools=[get_location, get_weather],
        debug=False,
        system_prompt=(
            "Give concise responses. "
            "When the user message includes latitude and longitude, use them "
            "directly with get_weather (or answer location questions from them). "
            "Never ask the user to type coordinates. "
            "If get_location returns status=needs_location, stop tool use for "
            "that turn only. On a later turn with coordinates available, call "
            "get_location again or use the provided coords."
        ),
        checkpointer=checkpointer,
    )


def create_title_model():
    model = ChatOpenAI(model="gpt-4o-mini")
    return model.with_structured_output(ConversationTitle)
