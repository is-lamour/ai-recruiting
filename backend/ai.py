import google.generativeai as genai
import json
import os
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

_fallback_key = os.getenv("GEMINI_API_KEY")

MODEL_NAME = "gemini-3.1-flash-lite"

def _make_models(api_key: str):
    cfg_smart   = genai.GenerationConfig(temperature=0, max_output_tokens=1024)
    cfg_screen  = genai.GenerationConfig(temperature=0, max_output_tokens=768)
    genai.configure(api_key=api_key)
    return (
        genai.GenerativeModel(MODEL_NAME, generation_config=cfg_smart),
        genai.GenerativeModel(MODEL_NAME, generation_config=cfg_screen),
    )

# ── Промпты ───────────────────────────────────────────────────────────────────

VACANCY_SUMMARY_PROMPT = """Сожми требования вакансии в одну строку до 600 символов.
Включи: ключевые навыки, стек технологий, опыт (лет), ключевые обязанности. Только суть, без воды.

ВАКАНСИЯ: {description}"""

SCREEN_PROMPT = """Ты опытный HR-аналитик. Оцени резюме по требованиям вакансии.
Ответь СТРОГО одним JSON-объектом без markdown, пробелов вне строк и переносов строк.

Формат ответа:
{{"score":75,"category":"consider","comment":"Краткий вывод до 100 символов.","summary":"Стек и опыт кандидата до 120 символов","questions":["Вопрос 1","Вопрос 2","Вопрос 3"],"pros":["Плюс 1","Плюс 2","Плюс 3"],"cons":["Минус 1","Минус 2"],"score_breakdown":[{{"criterion":"Название критерия","score":8,"weight":2,"note":"Коротко почему"}}]}}

Правила оценки:
- suitable>=80, consider 66-79, reject<66
- summary — ключевые навыки/стек/опыт одной строкой
- pros — 2-4 конкретных сильных стороны кандидата относительно вакансии
- cons — 2-4 конкретных слабых стороны или пробела
- score_breakdown — 4-6 критериев, извлечённых из требований вакансии. Каждый критерий: criterion (название навыка/компетенции), score (0-10), weight (важность: 3=критично, 2=важно, 1=желательно, 0.5=бонус), note (1 фраза почему такая оценка)
- Итоговый score должен коррелировать с взвешенной суммой score_breakdown: sum(score_i * weight_i) / sum(weight_i) * 10

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

    # Новые поля
    if not isinstance(result.get("pros"), list):
        result["pros"] = []
    if not isinstance(result.get("cons"), list):
        result["cons"] = []

    breakdown = result.get("score_breakdown")
    if not isinstance(breakdown, list):
        breakdown = []
    clean_breakdown = []
    for item in breakdown:
        if not isinstance(item, dict):
            continue
        clean_breakdown.append({
            "criterion": str(item.get("criterion", "")).strip(),
            "score":     max(0, min(10, int(item.get("score", 0)))),
            "weight":    float(item.get("weight", 1)),
            "note":      str(item.get("note", "")).strip(),
        })
    result["score_breakdown"] = clean_breakdown

    return result
