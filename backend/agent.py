import os
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI
from rich.pretty import pprint
from dotenv import load_dotenv
from langchain_core.tools import tool
from pydantic import BaseModel, Field

import httpx

load_dotenv()

WEATHER_API_KEY = os.getenv('OPENWEATHER_API_KEY') 

class ConversationTitle(BaseModel):
    conversation_name: str = Field(
        description="Short 3-6 word title summarizing the chat topic"
    )

@tool
def get_weather(latitude: str, longitude: str):
    """Get weather for a given latitude and longitude"""
    if not WEATHER_API_KEY:
        return "OpenWeather API key not found"
    
    response = httpx.get("https://api.openweathermap.org/data/2.5/weather",
                         params={
                             "lat": latitude,
                             "lon": longitude,
                             "appid": WEATHER_API_KEY,
                             "units": "metric"
                         })
    response.raise_for_status()
    data = response.json()
    return data

@tool
def get_location():
    """Get user's current location"""
    response = httpx.get("https://ipinfo.io/json", timeout=5).json()

    return {
        "city": response.get("city"),
        "country": response.get("country"),
        "latitude": response.get("loc").split(",")[0],
        "longitude": response.get("loc").split(",")[1]
    }
    
def create_llm_agent(checkpointer):
    model = ChatOpenAI(model="gpt-4o-mini")
    return create_agent(
        model,
        tools=[get_location, get_weather],
        debug=False,
        system_prompt="Give concise response",
        checkpointer=checkpointer
    )
    
def create_title_model():
    model = ChatOpenAI(model="gpt-4o-mini")
    return model.with_structured_output(ConversationTitle)