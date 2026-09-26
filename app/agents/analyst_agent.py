import json
import os
from dotenv import load_dotenv
from app.agents.prompts import STATISTICAL_INTENT_PROMPT

load_dotenv()

class AnalystAgent:
    def __init__(self):
        self._client = None

    def get_client(self):
        if self._client is None:
            from groq import Groq
            self._client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        return self._client

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

        models = ["groq/compound", "openai/gpt-oss-20b"]

        for model in models:
            try:
                client = self.get_client()
                kwargs = {
                    "model": model,
                    "messages": messages,
                    "temperature": 0.1,
                    "max_tokens": 500,
                }

                if model == "groq/compound":
                    kwargs["response_format"] = {"type": "json_object"}

                response = client.chat.completions.create(**kwargs)
                raw = response.choices[0].message.content.strip()

                if not raw:
                    continue

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