from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
import json
from pathlib import Path

from database import init_db, get_db, row_to_dict
from ai import screen_resume, summarize_vacancy

app = FastAPI(title="HH Auto Screening")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).parent / "static"


@app.on_event("startup")
def startup():
    init_db()


# ── Static / Dashboard ────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def root():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/health")
def health():
    return {"status": "ok"}


# ── Schemas ───────────────────────────────────────────────────────────────────

class VacancyCreate(BaseModel):
    title: str
    description: str


class CandidateScreen(BaseModel):
    vacancy_id: int
    name: Optional[str] = None
    hh_url: str
    resume_text: str


class StatusUpdate(BaseModel):
    status: str  # new | to_reject | to_huntflow | rejected | huntflow_sent


# ── Vacancies ─────────────────────────────────────────────────────────────────

@app.get("/api/vacancies")
def list_vacancies():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM vacancies ORDER BY created_at DESC"
        ).fetchall()
        return [row_to_dict(r) for r in rows]
    finally:
        conn.close()


@app.post("/api/vacancies")
def create_vacancy(data: VacancyCreate):
    requirements = summarize_vacancy(data.description)
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO vacancies (title, description, requirements) VALUES (?, ?, ?)",
            (data.title, data.description, requirements),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM vacancies WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        return row_to_dict(row)
    finally:
        conn.close()


@app.get("/api/vacancies/{vacancy_id}/screened-urls")
def screened_urls(vacancy_id: int):
    """Возвращает список уже скринированных URL резюме для вакансии."""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT hh_url FROM candidates WHERE vacancy_id = ?", (vacancy_id,)
        ).fetchall()
        return [row["hh_url"] for row in rows]
    finally:
        conn.close()


@app.put("/api/vacancies/{vacancy_id}")
def update_vacancy(vacancy_id: int, data: VacancyCreate):
    requirements = summarize_vacancy(data.description)
    conn = get_db()
    try:
        conn.execute(
            "UPDATE vacancies SET title = ?, description = ?, requirements = ? WHERE id = ?",
            (data.title, data.description, requirements, vacancy_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM vacancies WHERE id = ?", (vacancy_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Не найдено")
        return row_to_dict(row)
    finally:
        conn.close()


@app.delete("/api/vacancies/{vacancy_id}")
def delete_vacancy(vacancy_id: int):
    conn = get_db()
    try:
        conn.execute("DELETE FROM candidates WHERE vacancy_id = ?", (vacancy_id,))
        conn.execute("DELETE FROM vacancies WHERE id = ?", (vacancy_id,))
        conn.commit()
        return {"status": "deleted"}
    finally:
        conn.close()


# ── Screening ─────────────────────────────────────────────────────────────────

@app.post("/api/screen")
def screen_candidate(data: CandidateScreen):
    conn = get_db()
    try:
        # Если уже скринили — вернуть существующий результат
        existing = conn.execute(
            "SELECT * FROM candidates WHERE hh_url = ? AND vacancy_id = ?",
            (data.hh_url, data.vacancy_id),
        ).fetchone()
        if existing:
            d = row_to_dict(existing)
            d["questions"] = json.loads(d["questions"] or "[]")
            return d

        # Получить текст вакансии
        vacancy = conn.execute(
            "SELECT * FROM vacancies WHERE id = ?", (data.vacancy_id,)
        ).fetchone()
        if not vacancy:
            raise HTTPException(status_code=404, detail="Вакансия не найдена")

        # AI-скрининг (используем сжатые требования, не полное описание)
        requirements = vacancy["requirements"] or vacancy["description"][:500]
        result = screen_resume(requirements, data.resume_text)

        # Сохранить в БД
        cur = conn.execute(
            """INSERT INTO candidates
               (vacancy_id, name, hh_url, resume_text, score, category, ai_comment, questions, summary)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                data.vacancy_id,
                data.name,
                data.hh_url,
                data.resume_text,
                result["score"],
                result["category"],
                result["comment"],
                json.dumps(result["questions"], ensure_ascii=False),
                result.get("summary", ""),
            ),
        )
        conn.commit()

        row = conn.execute(
            "SELECT * FROM candidates WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        d = row_to_dict(row)
        d["questions"] = json.loads(d["questions"] or "[]")
        return d
    finally:
        conn.close()


# ── Candidates ────────────────────────────────────────────────────────────────

@app.get("/api/vacancies/{vacancy_id}/candidates")
def list_candidates(vacancy_id: int, category: Optional[str] = None):
    conn = get_db()
    try:
        query = "SELECT * FROM candidates WHERE vacancy_id = ?"
        params: list = [vacancy_id]
        if category:
            query += " AND category = ?"
            params.append(category)
        query += " ORDER BY score DESC"
        rows = conn.execute(query, params).fetchall()
        result = []
        for row in rows:
            d = row_to_dict(row)
            d["questions"] = json.loads(d["questions"] or "[]")
            result.append(d)
        return result
    finally:
        conn.close()


@app.patch("/api/candidates/{candidate_id}")
def update_status(candidate_id: int, data: StatusUpdate):
    conn = get_db()
    try:
        conn.execute(
            "UPDATE candidates SET status = ? WHERE id = ?",
            (data.status, candidate_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM candidates WHERE id = ?", (candidate_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Кандидат не найден")
        d = row_to_dict(row)
        d["questions"] = json.loads(d["questions"] or "[]")
        return d
    finally:
        conn.close()


# ── Stats ─────────────────────────────────────────────────────────────────────

@app.get("/api/vacancies/{vacancy_id}/stats")
def get_stats(vacancy_id: int):
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT category, COUNT(*) as cnt FROM candidates WHERE vacancy_id = ? GROUP BY category",
            (vacancy_id,),
        ).fetchall()
        by_cat = {"suitable": 0, "consider": 0, "reject": 0, "pending": 0}
        total = 0
        for row in rows:
            by_cat[row["category"]] = row["cnt"]
            total += row["cnt"]
        return {"total": total, **by_cat}
    finally:
        conn.close()


# ── Pending actions (для расширения) ─────────────────────────────────────────

@app.get("/api/vacancies/{vacancy_id}/pending-actions")
def pending_actions(vacancy_id: int):
    conn = get_db()
    try:
        to_reject = conn.execute(
            "SELECT id, hh_url, name FROM candidates WHERE vacancy_id = ? AND status = 'to_reject'",
            (vacancy_id,),
        ).fetchall()
        to_huntflow = conn.execute(
            "SELECT id, hh_url, name FROM candidates WHERE vacancy_id = ? AND status = 'to_huntflow'",
            (vacancy_id,),
        ).fetchall()
        return {
            "to_reject": [row_to_dict(r) for r in to_reject],
            "to_huntflow": [row_to_dict(r) for r in to_huntflow],
        }
    finally:
        conn.close()


@app.post("/api/vacancies/{vacancy_id}/mark-for-reject")
def mark_for_reject(vacancy_id: int):
    """Помечает всех кандидатов категории 'reject' как ожидающих отказа на HH."""
    conn = get_db()
    try:
        conn.execute(
            "UPDATE candidates SET status = 'to_reject' WHERE vacancy_id = ? AND category = 'reject' AND status = 'new'",
            (vacancy_id,),
        )
        conn.commit()
        count = conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE vacancy_id = ? AND status = 'to_reject'",
            (vacancy_id,),
        ).fetchone()[0]
        return {"queued": count}
    finally:
        conn.close()


@app.post("/api/vacancies/{vacancy_id}/mark-for-huntflow")
def mark_for_huntflow(vacancy_id: int):
    """Помечает всех кандидатов категории 'suitable' как ожидающих добавления в Huntflow."""
    conn = get_db()
    try:
        conn.execute(
            "UPDATE candidates SET status = 'to_huntflow' WHERE vacancy_id = ? AND category = 'suitable' AND status = 'new'",
            (vacancy_id,),
        )
        conn.commit()
        count = conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE vacancy_id = ? AND status = 'to_huntflow'",
            (vacancy_id,),
        ).fetchone()[0]
        return {"queued": count}
    finally:
        conn.close()
