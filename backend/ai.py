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
        max_output_tokens=8192,
    ),
)

# ── Промпты ───────────────────────────────────────────────────────────────────

VACANCY_SUMMARY_PROMPT = """Сожми требования вакансии в одну строку до 400 символов.
Включи: ключевые навыки, стек технологий, опыт (лет), ключевые обязанности. Только суть.

ВАКАНСИЯ: {description}"""

SCREEN_PROMPT = """Ты HR. Оцени резюме по требованиям вакансии. Ответь СТРОГО одной строкой JSON без markdown:
{{"score":75,"category":"consider","comment":"До 80 символов.","questions":["?","?","?"],"summary":"Стек и опыт кандидата до 100 символов"}}
Правила: suitable>=80, consider 66-79, reject<66. summary — ключевые навыки/стек/опыт кандидата.

ТРЕБОВАНИЯ ВАКАНСИИ:{requirements}
РЕЗЮМЕ:{resume_text}"""


def summarize_vacancy(description: str) -> str:
    """Сжимает описание вакансии в короткую строку требований."""
    prompt = VACANCY_SUMMARY_PROMPT.format(description=description[:4000])
    response = model.generate_content(prompt)
    return response.text.strip()[:500]


def screen_resume(requirements: str, resume_text: str) -> dict:
    """Скринирует резюме по сжатым требованиям вакансии."""
    prompt = SCREEN_PROMPT.format(
        requirements=requirements[:500],
        resume_text=resume_text[:3000],
    )
    response = model.generate_content(prompt)
    finish = response.candidates[0].finish_reason if response.candidates else "?"
    text = response.text.strip()
    print(f"[AI finish={finish}] FULL: {repr(text)}")

    if "```" in text:
        lines = text.splitlines()
        text = "\n".join(l for l in lines if not l.strip().startswith("```"))

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
            "summary": "",
        }

    result["score"] = max(0, min(100, int(result.get("score", 0))))
    cat = result.get("category", "")
    if cat not in ("reject", "consider", "suitable"):
        s = result["score"]
        result["category"] = "suitable" if s >= 80 else ("consider" if s >= 66 else "reject")
    if not isinstance(result.get("questions"), list):
        result["questions"] = []
    if not isinstance(result.get("summary"), str):
        result["summary"] = ""

    return result
