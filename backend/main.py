from dotenv import load_dotenv
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langchain.agents import create_agent, structured_output
from pydantic import BaseModel
from rich.pretty import pprint
from langgraph.checkpoint.postgres import PostgresSaver
import os 

import requests
load_dotenv()

DB_URI = os.getenv('SUPABASE_DB_URI')

@tool
def get_weather(latitude: str, longitude: str):
    """Get Weather for a given City"""
    import os

    api_key = os.environ.get("OPENWEATHER_API_KEY")
    if not api_key:
        return "OpenWeather API key not found."

    url = (
        f"https://api.openweathermap.org/data/2.5/weather?"
        f"lat={latitude}&lon={longitude}&appid={api_key}&units=metric"
    )
    try:
        response = requests.get(url, timeout=5)
        response.raise_for_status()
        data = response.json()
        weather_desc = data["weather"][0]["description"]
        temp = data["main"]["temp"]
        fahrenheit = (temp * 9/5) + 32
        city = data.get("name")
        return data, {"fahrenheit": fahrenheit}
    except Exception as e:
        return f"Unable to fetch weather: {e}"

def get_location():
    """Get user's current location details (city, country, lat/long) via IP lookup."""
    response = requests.get("https://ipinfo.io/json", timeout=5).json()
    
    # hardcode chicago
    # return {
    #     "city": "Chicago",
    #     "country": "United States",
    #     "latitude": "41.8781",
    #     "longitude": "-87.6298"
    # }

    return {
        "city": response.get("city"),
        "country": response.get("country"),
        "latitude": response.get("loc").split(",")[0],
        "longitude": response.get("loc").split(",")[1]
    }




model = ChatOpenAI(model="gpt-4o-mini")

with PostgresSaver.from_conn_string(DB_URI) as checkpointer:
    checkpointer.setup()
    agent = create_agent(
            model,
            tools=[get_weather, get_location],
            debug=False,
            system_prompt="Give concise response like a chat message",
            checkpointer=checkpointer
        )

    while True:

        input_message = input("Enter your message: ")

        if input_message.lower() == "exit":
            break

        response = agent.invoke({"messages": [{'role': 'user', 'content': input_message}]},{"configurable": {"thread_id": "1"}})
        pprint(response['messages'][-1].content)

