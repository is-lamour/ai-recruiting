import google.generativeai as genai
import json
import os
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

_api_key = os.getenv("GEMINI_API_KEY")
if not _api_key:
    raise RuntimeError(
        "GEMINI_API_KEY не задан. Создайте файл .env рядом с start.bat "
        "и добавьте строку: GEMINI_API_KEY=ваш_ключ"
    )

genai.configure(api_key=_api_key)

model = genai.GenerativeModel(
    "gemini-2.5-flash",
    generation_config=genai.GenerationConfig(
        temperature=0,
        max_output_tokens=4096,
    ),
)

# Короткий промпт = быстрее + дешевле
PROMPT = """Ты HR. Оцени резюме. Ответь СТРОГО одной строкой JSON без переносов, без markdown:
{{"score":75,"category":"consider","comment":"Краткий вывод до 80 символов.","questions":["Вопрос 1?","Вопрос 2?","Вопрос 3?"]}}
Правила: suitable>=80, consider 66-79, reject<66. Каждый вопрос до 60 символов.

ВАКАНСИЯ:{vacancy_text}
РЕЗЮМЕ:{resume_text}"""


def screen_resume(vacancy_text: str, resume_text: str) -> dict:
    prompt = PROMPT.format(
        vacancy_text=vacancy_text[:3000],   # ограничиваем размер
        resume_text=resume_text[:5000],
    )
    response = model.generate_content(prompt)
    text = response.text.strip()

    if "```" in text:
        lines = text.splitlines()
        text = "\n".join(l for l in lines if not l.strip().startswith("```"))

    # Вырезаем JSON из возможного мусора вокруг
    start = text.find("{")
    end   = text.rfind("}") + 1
    if start != -1 and end > start:
        text = text[start:end]

    try:
        result = json.loads(text)
    except json.JSONDecodeError as e:
        print(f"[AI JSON ERROR] {e} | text: {repr(text[:300])}")
        return {
            "score": 50,
            "category": "consider",
            "comment": "Не удалось разобрать ответ AI. Проверьте резюме вручную.",
            "questions": [],
        }

    result["score"] = max(0, min(100, int(result.get("score", 0))))
    cat = result.get("category", "")
    if cat not in ("reject", "consider", "suitable"):
        s = result["score"]
        result["category"] = "suitable" if s >= 80 else ("consider" if s >= 66 else "reject")
    if not isinstance(result.get("questions"), list):
        result["questions"] = []

    return result
