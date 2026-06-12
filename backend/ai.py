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
    cfg_boolean = genai.GenerationConfig(temperature=0, max_output_tokens=2048)
    genai.configure(api_key=api_key)
    return (
        genai.GenerativeModel(MODEL_NAME, generation_config=cfg_smart),
        genai.GenerativeModel(MODEL_NAME, generation_config=cfg_screen),
        genai.GenerativeModel(MODEL_NAME, generation_config=cfg_boolean),
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


METRICS_PROMPT = """Ты опытный HR-аналитик. Составь список из 5-7 метрик для оценки кандидатов на вакансию.
Ответь СТРОГО одним JSON-массивом без markdown и пояснений.

Формат: [{{"name":"Название метрики","weight":5.0}}, ...]

Правила для weight (строго соблюдать):
- Максимум одна метрика может иметь вес 7.0 — это самое важное требование вакансии
- Остальные метрики: 3.0–6.0
- Желательные/бонусные навыки: 1.0–2.5
- Среднее значение по всем весам должно быть около 4.5
- Никогда не ставь вес выше 7.0
- Разброс между максимальным и минимальным весом должен быть не менее 3.0

Пример правильного распределения для 6 метрик: 7.0, 6.0, 5.5, 4.0, 3.0, 2.0

- name: конкретный навык или компетенция, 2-5 слов, на русском
- 5-7 метрик, охватывающих ключевые требования вакансии
- Сортировка по убыванию weight

ВАКАНСИЯ: {description}"""

SCREEN_WITH_METRICS_PROMPT = """Ты опытный HR-аналитик. Оцени резюме по требованиям вакансии, используя ЗАДАННЫЕ метрики.
Ответь СТРОГО одним JSON-объектом без markdown, пробелов вне строк и переносов строк.

Формат ответа:
{{"score":75,"category":"consider","comment":"Краткий вывод до 100 символов.","summary":"Стек и опыт кандидата до 120 символов","questions":["Вопрос 1","Вопрос 2"],"pros":["Плюс 1","Плюс 2"],"cons":["Минус 1","Минус 2"],"score_breakdown":[{{"criterion":"Название метрики","score":8,"weight":7.0,"note":"Коротко почему"}}]}}

Правила оценки:
- suitable>=80, consider 66-79, reject<66
- score_breakdown должен содержать ВСЕ метрики из списка ниже в том же порядке
- criterion — точное название метрики из списка
- score — оценка 0-10 по каждой метрике
- weight — берётся из списка метрик БЕЗ изменений
- note — 1 фраза с обоснованием оценки
- Итоговый score = sum(score_i * weight_i) / sum(weight_i) * 10, округлённый до целого
- summary — ключевые навыки/стек/опыт одной строкой
- pros — 2-4 конкретных сильных стороны относительно вакансии
- cons — 2-4 конкретных слабых стороны или пробела
- questions — 2-3 уточняющих вопроса по пробелам

ТРЕБОВАНИЯ ВАКАНСИИ: {requirements}
МЕТРИКИ ОЦЕНКИ (JSON): {metrics_json}
РЕЗЮМЕ: {resume_text}"""

BOOLEAN_SEARCH_PROMPT = """Ты — эксперт по поисковым запросам HeadHunter.
По описанию вакансии составь 3 Boolean-запроса для поиска резюме.
Не используй название должности внутри поисковых запросов — строй поиск по стеку, навыкам, инструментам, сфере и функционалу.

Используй синтаксис HH:
OR — варианты и синонимы: python OR java
AND — обязательные условия: python AND django
"..." — точная фраза: "React Query"
(...) — группировка: (python OR java) AND (django OR spring)
* — начало слова: аналит*
! — точная форма: !typescript
Не используй NOT.

ЖЁСТКИЕ ТРЕБОВАНИЯ К СТРУКТУРЕ — нарушать нельзя:

ШИРОКИЙ запрос:
- Максимум 2 блока AND
- Каждый блок — широкий список синонимов через OR (минимум 5–7 вариантов)
- Включает разные написания: английский, русский, аббревиатуры, смежные технологии
- Цель: поймать как можно больше релевантных кандидатов, допуская «шум»
- Длина: не менее 120 символов

СРЕДНИЙ запрос:
- 3–4 блока AND
- Каждый блок — 3–5 OR-вариантов ключевых технологий/навыков
- Баланс между охватом и точностью
- Заметно отличается от широкого: строже по составу, меньше синонимов
- Длина: не менее 150 символов

УЗКИЙ запрос:
- 5+ блоков AND
- Каждый блок — 1–3 OR-варианта только обязательных технологий
- Только то, что кандидат обязан знать согласно вакансии
- Максимальная точность, минимальный охват
- Длина: не менее 150 символов

Дополнительные правила:
Синонимы, варианты написания объединяй через OR.
Soft skills и общие слова не используй.
Если данных мало — делай лучший вариант по имеющемуся описанию.

Формат ответа (строго соблюдай метки, каждое поле на отдельной строке):
Должность: <название>
Ключевой стек / навыки: <перечисление>
Широкий запрос: <запрос>
Средний запрос: <запрос>
Узкий запрос: <запрос>
Комментарий: <пояснение>

Описание вакансии:
{description}"""


def _resolve_key(api_key: str | None) -> str:
    key = api_key or _fallback_key
    if not key:
        raise RuntimeError(
            "GEMINI_API_KEY не задан. Введите ключ в расширении или создайте .env файл."
        )
    return key


def generate_metrics(description: str, api_key: str | None = None) -> list:
    key = _resolve_key(api_key)
    model_smart, _, _ = _make_models(key)
    prompt = METRICS_PROMPT.format(description=description[:4000])
    response = model_smart.generate_content(prompt)
    text = response.text.strip()

    if "```" in text:
        lines = text.splitlines()
        text = "\n".join(l for l in lines if not l.strip().startswith("```"))

    start = text.find("[")
    end   = text.rfind("]") + 1
    if start != -1 and end > start:
        text = text[start:end]

    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return []

    raw_metrics = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        try:
            weight = float(item.get("weight", 5.0))
            weight = max(0.0, min(10.0, weight))
        except (ValueError, TypeError):
            weight = 5.0
        raw_metrics.append({"name": name, "weight": weight})

    if not raw_metrics:
        return []

    # Масштабируем: если максимальный вес > 7, сжимаем всё пропорционально так чтобы max=7
    max_w = max(m["weight"] for m in raw_metrics)
    if max_w > 7.0:
        scale = 7.0 / max_w
        for m in raw_metrics:
            m["weight"] = m["weight"] * scale

    # Округляем до шага 0.5
    metrics = []
    for m in raw_metrics:
        m["weight"] = max(0.5, round(m["weight"] * 2) / 2)
        metrics.append(m)

    return metrics


def summarize_vacancy(description: str, api_key: str | None = None) -> str:
    key = _resolve_key(api_key)
    model_smart, _, _ = _make_models(key)
    prompt = VACANCY_SUMMARY_PROMPT.format(description=description[:4000])
    response = model_smart.generate_content(prompt)
    return response.text.strip()[:700]


def generate_boolean_search(description: str, api_key: str | None = None) -> dict:
    key = _resolve_key(api_key)
    _, _, model_boolean = _make_models(key)
    prompt = BOOLEAN_SEARCH_PROMPT.format(description=description[:4000])
    response = model_boolean.generate_content(prompt)
    text = response.text.strip()

    def extract(label: str) -> str:
        for line in text.splitlines():
            if line.startswith(label):
                return line[len(label):].strip()
        return ""

    return {
        "position":     extract("Должность:"),
        "stack":        extract("Ключевой стек / навыки:"),
        "wide":         extract("Широкий запрос:"),
        "medium":       extract("Средний запрос:"),
        "narrow":       extract("Узкий запрос:"),
        "comment":      extract("Комментарий:"),
        "raw":          text,
    }


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


def screen_resume(requirements: str, resume_text: str, api_key: str | None = None, metrics: list | None = None) -> dict:
    key = _resolve_key(api_key)
    _, model_fast, _ = _make_models(key)

    if metrics:
        metrics_json = json.dumps(metrics, ensure_ascii=False)
        prompt = SCREEN_WITH_METRICS_PROMPT.format(
            requirements=requirements[:700],
            metrics_json=metrics_json,
            resume_text=resume_text[:3000],
        )
    else:
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

    # Нормализуем score_breakdown до финального score
    breakdown = result.get("score_breakdown")
    if not isinstance(breakdown, list):
        breakdown = []
    clean_breakdown = []
    for item in breakdown:
        if not isinstance(item, dict):
            continue
        clean_breakdown.append({
            "criterion": str(item.get("criterion", "")).strip(),
            "score":     max(0, min(10, int(float(str(item.get("score", 0)).replace(",", "."))))),
            "weight":    max(0.0, float(str(item.get("weight", 1)).replace(",", "."))),
            "note":      str(item.get("note", "")).strip(),
        })
    result["score_breakdown"] = clean_breakdown

    # Если заданы метрики — пересчитываем score по формуле взвешенного среднего
    if metrics and clean_breakdown:
        total_w = sum(b["weight"] for b in clean_breakdown)
        if total_w > 0:
            weighted = sum(b["score"] * b["weight"] for b in clean_breakdown)
            result["score"] = max(0, min(100, round(weighted / total_w * 10)))
        else:
            result["score"] = 0
    else:
        result["score"] = _safe_score(result.get("score"))

    s = result["score"]
    result["category"] = "suitable" if s >= 80 else ("consider" if s >= 66 else "reject")
    if not isinstance(result.get("questions"), list):
        result["questions"] = []
    if not isinstance(result.get("summary"), str):
        result["summary"] = ""
    if not isinstance(result.get("comment"), str) or not result["comment"].strip():
        result["comment"] = "Комментарий недоступен. Проверьте резюме вручную."

    if not isinstance(result.get("pros"), list):
        result["pros"] = []
    if not isinstance(result.get("cons"), list):
        result["cons"] = []

    return result
