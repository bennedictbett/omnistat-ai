import json
import os
from dotenv import load_dotenv
from app.agents.prompts import STATISTICAL_INTENT_PROMPT
from groq import Groq

load_dotenv()

client = Groq(api_key=os.getenv("GROQ_API_KEY"))

class AnalystAgent:
    async def process(self, query: str, context: dict = {}) -> dict:
        """
        Convert natural language research query into
        structured statistical procedure specification
        """
        messages = [
            {
                "role": "system",
                "content": STATISTICAL_INTENT_PROMPT
            },
            {
                "role": "user",
                "content": f"Query: {query}\nContext: {json.dumps(context)}"
            }
        ]

        response = client.chat.completions.create(
            model="groq/compound",
            messages=messages,
            temperature=0.1,
            max_tokens=500,
            response_format={"type": "json_object"}
        )

        raw = response.choices[0].message.content.strip()

        try:
            return {
                "success": True,
                "intent": json.loads(raw)
            }
        except json.JSONDecodeError:
            return {
                "success": False,
                "error": "Failed to parse intent",
                "raw": raw
            }