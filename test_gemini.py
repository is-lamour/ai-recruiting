import sys
import google.generativeai as genai

if len(sys.argv) < 2:
    print("Использование: python test_gemini.py <GEMINI_API_KEY>")
    sys.exit(1)

api_key = sys.argv[1]
print(f"API key: {api_key[:10]}...{api_key[-4:]}")

genai.configure(api_key=api_key)

print("\nДоступные модели:")
for m in genai.list_models():
    if "generateContent" in m.supported_generation_methods:
        print(f"  {m.name}")

print("\nТест запроса...")
model = genai.GenerativeModel("gemini-3.1-flash-lite")
response = model.generate_content("Скажи 'привет' одним словом")
print(f"Ответ: {response.text}")
print("\n✓ API работает!")
