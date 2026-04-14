import os
from dotenv import load_dotenv
load_dotenv()

import google.generativeai as genai

api_key = os.getenv("GEMINI_API_KEY")
print(f"API key: {api_key[:10]}...{api_key[-4:]}")

genai.configure(api_key=api_key)

print("\nДоступные модели:")
for m in genai.list_models():
    if "generateContent" in m.supported_generation_methods:
        print(f"  {m.name}")

print("\nТест запроса...")
model = genai.GenerativeModel("gemini-2.5-flash")
response = model.generate_content("Скажи 'привет' одним словом")
print(f"Ответ: {response.text}")
print("\n✓ API работает!")
