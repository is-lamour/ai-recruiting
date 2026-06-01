"""
Тест AI-скрининга резюме.
Использование: python test_screening.py <GEMINI_API_KEY>
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

from ai import screen_resume, summarize_vacancy

REQUIREMENTS = "Python 3+ лет, Django/FastAPI, PostgreSQL, REST API, опыт в backend-разработке"

RESUME_GOOD = """
Иван Иванов, Backend-разработчик
Опыт: 4 года
Стек: Python, Django, FastAPI, PostgreSQL, Redis, Docker
Последнее место: ООО Технологии — backend-разработчик 3 года
Разрабатывал REST API для мобильного приложения (500k+ пользователей)
Образование: МГТУ, Computer Science, 2019
"""

RESUME_BAD = """
Мария Петрова, Менеджер по продажам
Опыт: 5 лет
Работала в розничных продажах, вела клиентскую базу в Excel
Навыки: переговоры, CRM Bitrix24, холодные звонки
Образование: РЭУ Плеханова, Маркетинг, 2018
"""

def check(label, condition, detail=""):
    status = "✓" if condition else "✗"
    print(f"  {status} {label}" + (f": {detail}" if detail else ""))
    return condition

def test_screen_resume(api_key):
    print("\n── test_screen_resume (подходящий кандидат) ──")
    r = screen_resume(REQUIREMENTS, RESUME_GOOD, api_key=api_key)
    print(f"  Ответ AI: {r}")
    ok = True
    ok &= check("score int",      isinstance(r.get("score"), int))
    ok &= check("score 0-100",    0 <= r.get("score", -1) <= 100)
    ok &= check("category valid", r.get("category") in ("suitable", "consider", "reject"))
    ok &= check("comment str",    isinstance(r.get("comment"), str) and len(r["comment"]) > 0)
    ok &= check("questions list", isinstance(r.get("questions"), list))
    ok &= check("summary str",    isinstance(r.get("summary"), str))
    ok &= check("score >= 66",    r.get("score", 0) >= 66, f"score={r.get('score')}")
    return ok

def test_screen_resume_bad(api_key):
    print("\n── test_screen_resume (неподходящий кандидат) ──")
    r = screen_resume(REQUIREMENTS, RESUME_BAD, api_key=api_key)
    print(f"  Ответ AI: {r}")
    ok = True
    ok &= check("score < 66",     r.get("score", 100) < 66, f"score={r.get('score')}")
    ok &= check("category=reject",r.get("category") == "reject", f"category={r.get('category')}")
    return ok

def test_summarize_vacancy(api_key):
    print("\n── test_summarize_vacancy ──")
    description = """
    Ищем Python-разработчика со знанием Django и FastAPI.
    Требования: опыт от 3 лет, PostgreSQL, REST API, Docker.
    Обязанности: разработка бэкенда, code review, написание тестов.
    """
    summary = summarize_vacancy(description, api_key=api_key)
    print(f"  Summary: {summary}")
    ok = True
    ok &= check("не пустой",      len(summary) > 0)
    ok &= check("до 700 символов",len(summary) <= 700, f"len={len(summary)}")
    return ok

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Использование: python test_screening.py <GEMINI_API_KEY>")
        sys.exit(1)

    api_key = sys.argv[1]
    print(f"API key: {api_key[:10]}...{api_key[-4:]}")

    results = []
    results.append(test_screen_resume(api_key))
    results.append(test_screen_resume_bad(api_key))
    results.append(test_summarize_vacancy(api_key))

    passed = sum(results)
    total  = len(results)
    print(f"\n{'✓ Все тесты прошли' if passed == total else f'✗ Провалено: {total - passed}/{total}'} ({passed}/{total})")
    sys.exit(0 if passed == total else 1)
