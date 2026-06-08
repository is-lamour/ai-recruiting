import google.generativeai as genai
import json
import os
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

_fallback_key = os.getenv("GEMINI_API_KEY")

MODEL_NAME = "gemini-3.1-flash-lite"

def _make_models(api_key: str):
    cfg_smart = genai.GenerationConfig(temperature=0, max_output_tokens=1024)
    cfg_fast  = genai.GenerationConfig(temperature=0, max_output_tokens=256)
    genai.configure(api_key=api_key)
    return (
        genai.GenerativeModel(MODEL_NAME, generation_config=cfg_smart),
        genai.GenerativeModel(MODEL_NAME, generation_config=cfg_fast),
    )

# ── Промпты ───────────────────────────────────────────────────────────────────

VACANCY_SUMMARY_PROMPT = """Сожми требования вакансии в одну строку до 600 символов.
Включи: ключевые навыки, стек технологий, опыт (лет), ключевые обязанности. Только суть, без воды.

ВАКАНСИЯ: {description}"""

SCREEN_PROMPT = """Ты HR. Оцени резюме по требованиям вакансии. Ответь СТРОГО одной строкой JSON без markdown:
{{"score":75,"category":"consider","comment":"До 80 символов.","questions":["?","?","?"],"summary":"Стек и опыт кандидата до 100 символов"}}
Правила: suitable>=80, consider 66-79, reject<66. summary — ключевые навыки/стек/опыт кандидата.

ТРЕБОВАНИЯ ВАКАНСИИ:{requirements}
РЕЗЮМЕ:{resume_text}"""


def _resolve_key(api_key: str | None) -> str:
    key = api_key or _fallback_key
    if not key:
        raise RuntimeError(
            "GEMINI_API_KEY не задан. Введите ключ в расширении или создайте .env файл."
        )
    return key


def summarize_vacancy(description: str, api_key: str | None = None) -> str:
    key = _resolve_key(api_key)
    model_smart, _ = _make_models(key)
    prompt = VACANCY_SUMMARY_PROMPT.format(description=description[:4000])
    response = model_smart.generate_content(prompt)
    return response.text.strip()[:700]


def _safe_score(value) -> int:
    """Парсит score из ответа LLM: int, float, '75/100', '75%', None → int 0-100."""
    if value is None:
        return 0
    try:
        if isinstance(value, (int, float)):
            return max(0, min(100, int(value)))
        s = str(value).strip()
        # "75/100" → берём числитель
        if "/" in s:
            s = s.split("/")[0].strip()
        # "75%" → убираем %
        s = s.rstrip("%").strip()
        return max(0, min(100, int(float(s))))
    except (ValueError, TypeError):
        return 0


def screen_resume(requirements: str, resume_text: str, api_key: str | None = None) -> dict:
    key = _resolve_key(api_key)
    _, model_fast = _make_models(key)
    prompt = SCREEN_PROMPT.format(
        requirements=requirements[:700],
        resume_text=resume_text[:3000],
    )
    response = model_fast.generate_content(prompt)
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

    result["score"] = _safe_score(result.get("score"))
    cat = result.get("category", "")
    if cat not in ("reject", "consider", "suitable"):
        s = result["score"]
        result["category"] = "suitable" if s >= 80 else ("consider" if s >= 66 else "reject")
    if not isinstance(result.get("questions"), list):
        result["questions"] = []
    if not isinstance(result.get("summary"), str):
        result["summary"] = ""
    if not isinstance(result.get("comment"), str) or not result["comment"].strip():
        result["comment"] = "Комментарий недоступен. Проверьте резюме вручную."

    return result
