import json
import os
from dotenv import load_dotenv
from app.agents.prompts import STATISTICAL_INTENT_PROMPT
from groq import Groq

load_dotenv()

client = Groq(api_key=os.getenv("GROQ_API_KEY"))

class AnalystAgent:
    async def process(self, query: str, context: dict = {}) -> dict:
        messages = [
            {
                "role": "system",
                "content": STATISTICAL_INTENT_PROMPT
            },
            {
                "role": "user",
                "content": f"Query: {query}\nContext: {json.dumps(context)}\n\nRespond with ONLY a JSON object, no other text."
            }
        ]

        # Try primary model first, fallback to secondary
        models = ["groq/compound", "openai/gpt-oss-20b"]

        for model in models:
            try:
                kwargs = {
                    "model": model,
                    "messages": messages,
                    "temperature": 0.1,
                    "max_tokens": 500,
                }

                # Only add json mode for models that support it
                if model == "groq/compound":
                    kwargs["response_format"] = {"type": "json_object"}

                response = client.chat.completions.create(**kwargs)
                raw = response.choices[0].message.content.strip()

                if not raw:
                    continue

                # Clean up markdown if present
                raw = raw.replace("```json", "").replace("```", "").strip()

                return {
                    "success": True,
                    "intent": json.loads(raw),
                    "model_used": model
                }

            except (json.JSONDecodeError, Exception):
                continue

        return {
            "success": False,
            "error": "Failed to parse intent — try rephrasing your query"
        }