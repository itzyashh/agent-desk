import json
import os
from contextvars import ContextVar

from langchain.agents import create_agent
from langchain_openai import ChatOpenAI
from dotenv import load_dotenv
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


def _message_indicates_needs_location(content) -> bool:
    if content is None:
        return False

    if isinstance(content, dict):
        return content.get("status") == NEEDS_LOCATION_STATUS

    if isinstance(content, str):
        try:
            parsed = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            return NEEDS_LOCATION_STATUS in content
        if isinstance(parsed, dict):
            return parsed.get("status") == NEEDS_LOCATION_STATUS
        return NEEDS_LOCATION_STATUS in content

    return False


def location_required_in_messages(messages) -> bool:
    for message in messages:
        content = getattr(message, "content", None)
        if _message_indicates_needs_location(content):
            return True

        # ToolMessage / dict-shaped messages from some runtimes
        if isinstance(message, dict):
            if _message_indicates_needs_location(message.get("content")):
                return True

    return False


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
    """Get user's current location. Call this when the user asks about
    weather or location without naming a city. If coordinates are not
    available yet, this returns needs_location and the client will supply them.
    """
    coords = _request_location.get()
    if coords is None:
        return {"status": NEEDS_LOCATION_STATUS}

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
        system_prompt="Give concise response",
        checkpointer=checkpointer,
    )


def create_title_model():
    model = ChatOpenAI(model="gpt-4o-mini")
    return model.with_structured_output(ConversationTitle)
