import json
import os
from app.agents.prompts import STATISTICAL_INTENT_PROMPT
from groq import Groq

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
            model="llama3-8b-8192",
            messages=messages,
            temperature=0.1,
            max_tokens=500
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