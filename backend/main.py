from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional
import json
import io
import requests as http_requests
from pathlib import Path
from bs4 import BeautifulSoup
import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
from openpyxl.utils import get_column_letter

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
    requirements: Optional[str] = None  # если передано — используется вместо AI-генерации


class CandidateScreen(BaseModel):
    vacancy_id: int
    name: Optional[str] = None
    hh_url: str
    resume_text: str


class StatusUpdate(BaseModel):
    status: str  # new | to_reject | to_huntflow | rejected | huntflow_sent


# ── Background tasks ──────────────────────────────────────────────────────────

def _get_gemini_key(request: Request) -> Optional[str]:
    return request.headers.get("X-Gemini-Key") or None


def _generate_summary_bg(vacancy_id: int, description: str, api_key: Optional[str] = None):
    """Генерирует summary вакансии в фоне и сохраняет в БД."""
    try:
        requirements = summarize_vacancy(description, api_key=api_key)
        conn = get_db()
        try:
            conn.execute(
                "UPDATE vacancies SET requirements = ? WHERE id = ?",
                (requirements, vacancy_id),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        print(f"[summary bg error] vacancy_id={vacancy_id}: {e}")


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
def create_vacancy(request: Request, data: VacancyCreate, background_tasks: BackgroundTasks):
    manual_req = data.requirements.strip() if data.requirements and data.requirements.strip() else None
    api_key = _get_gemini_key(request)
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO vacancies (title, description, requirements) VALUES (?, ?, ?)",
            (data.title, data.description, manual_req or ""),
        )
        conn.commit()
        vacancy_id = cur.lastrowid
        if not manual_req:
            background_tasks.add_task(_generate_summary_bg, vacancy_id, data.description, api_key)
        row = conn.execute("SELECT * FROM vacancies WHERE id = ?", (vacancy_id,)).fetchone()
        return row_to_dict(row)
    finally:
        conn.close()


@app.put("/api/vacancies/{vacancy_id}")
def update_vacancy(vacancy_id: int, request: Request, data: VacancyCreate, background_tasks: BackgroundTasks):
    manual_req = data.requirements.strip() if data.requirements and data.requirements.strip() else None
    api_key = _get_gemini_key(request)
    conn = get_db()
    try:
        conn.execute(
            "UPDATE vacancies SET title = ?, description = ?, requirements = ? WHERE id = ?",
            (data.title, data.description, manual_req or "", vacancy_id),
        )
        conn.commit()
        if not manual_req:
            background_tasks.add_task(_generate_summary_bg, vacancy_id, data.description, api_key)
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


@app.get("/api/vacancies/{vacancy_id}/screened-urls")
def screened_urls(vacancy_id: int):
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT hh_url FROM candidates WHERE vacancy_id = ?", (vacancy_id,)
        ).fetchall()
        return [row["hh_url"] for row in rows]
    finally:
        conn.close()


# ── Parse HH vacancy URL ──────────────────────────────────────────────────────

@app.get("/api/parse-hh-vacancy")
def parse_hh_vacancy(url: str):
    """Загружает страницу вакансии HH и возвращает title + description."""
    url = url.strip().strip("<>")
    try:
        resp = http_requests.get(url, timeout=15, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
            "Accept-Language": "ru-RU,ru;q=0.9",
        })
        resp.raise_for_status()
        resp.encoding = "utf-8"
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Не удалось загрузить страницу: {e}")

    soup = BeautifulSoup(resp.text, "html.parser")

    # Заголовок
    title_el = (
        soup.find(attrs={"data-qa": "vacancy-title"}) or
        soup.find("h1")
    )
    title = title_el.get_text(" ", strip=True) if title_el else ""
    # Убираем подзаголовки вроде "(архив 7 мая 2025)"
    if title_el:
        for sub in title_el.find_all(["div", "span"]):
            sub.decompose()
        title = title_el.get_text(strip=True)

    # Описание — несколько вариантов селекторов
    desc_el = (
        soup.find(attrs={"data-qa": "vacancy-description"}) or
        soup.find("div", class_=lambda c: c and "vacancy-description" in " ".join(c)) or
        soup.find(attrs={"data-qa": "vacancy-branded-description"}) or
        soup.find("div", class_=lambda c: c and "brandingDescription" in " ".join(c if c else []))
    )
    description = desc_el.get_text(separator="\n", strip=True) if desc_el else ""

    print(f"[parse-hh] title={repr(title[:60])} desc_len={len(description)}")

    if not title:
        raise HTTPException(status_code=422, detail="Не удалось найти заголовок вакансии")
    if not description:
        raise HTTPException(status_code=422, detail="Не удалось найти описание вакансии. Попробуйте вставить текст вручную.")

    return {"title": title, "description": description}


# ── Screening ─────────────────────────────────────────────────────────────────

@app.post("/api/screen")
def screen_candidate(request: Request, data: CandidateScreen):
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT * FROM candidates WHERE hh_url = ? AND vacancy_id = ?",
            (data.hh_url, data.vacancy_id),
        ).fetchone()
        if existing:
            d = row_to_dict(existing)
            d["questions"] = json.loads(d["questions"] or "[]")
            return d

        vacancy = conn.execute(
            "SELECT * FROM vacancies WHERE id = ?", (data.vacancy_id,)
        ).fetchone()
        if not vacancy:
            raise HTTPException(status_code=404, detail="Вакансия не найдена")

        requirements = vacancy["requirements"] or vacancy["description"][:500]
        result = screen_resume(requirements, data.resume_text, api_key=_get_gemini_key(request))

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


@app.delete("/api/candidates/{candidate_id}")
def delete_candidate(candidate_id: int):
    conn = get_db()
    try:
        conn.execute("DELETE FROM candidates WHERE id = ?", (candidate_id,))
        conn.commit()
        return {"status": "deleted"}
    finally:
        conn.close()


# ── Export ────────────────────────────────────────────────────────────────────

@app.get("/api/vacancies/{vacancy_id}/export")
def export_candidates(vacancy_id: int):
    conn = get_db()
    try:
        vacancy_row = conn.execute("SELECT * FROM vacancies WHERE id = ?", (vacancy_id,)).fetchone()
        if not vacancy_row:
            raise HTTPException(status_code=404, detail="Вакансия не найдена")
        vacancy = row_to_dict(vacancy_row)

        rows = conn.execute(
            "SELECT * FROM candidates WHERE vacancy_id = ? ORDER BY score DESC", (vacancy_id,)
        ).fetchall()
        candidates = []
        for r in rows:
            d = row_to_dict(r)
            d["questions"] = json.loads(d["questions"] or "[]")
            candidates.append(d)
    finally:
        conn.close()

    # ── Стили ─────────────────────────────────────────────────────────────────
    FILLS = {
        "suitable": PatternFill("solid", fgColor="DCFCE7"),
        "consider":  PatternFill("solid", fgColor="FEF3C7"),
        "reject":    PatternFill("solid", fgColor="FEE2E2"),
        "pending":   PatternFill("solid", fgColor="F3F4F6"),
    }
    SCORE_FONT = {
        "suitable": Font(bold=True, color="16A34A"),
        "consider":  Font(bold=True, color="D97706"),
        "reject":    Font(bold=True, color="DC2626"),
        "pending":   Font(bold=True, color="6B7280"),
    }
    HEADER_FILL = PatternFill("solid", fgColor="1E293B")
    HEADER_FONT = Font(bold=True, color="FFFFFF")
    WRAP = Alignment(wrap_text=True, vertical="top")
    thin = Side(style="thin", color="E2E8F0")
    BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)

    CAT_LABELS = {"suitable": "Подходит", "consider": "Подумать", "reject": "Отказ", "pending": "Ожидание"}
    STATUS_LABELS = {
        "new": "", "to_reject": "На отказ", "to_huntflow": "В Huntflow",
        "rejected": "Отказ отправлен", "huntflow_sent": "Отправлен в HF",
    }

    COLUMNS = [
        ("Балл",       8),
        ("Категория",  12),
        ("Имя",        24),
        ("Статус",     16),
        ("Краткое резюме", 40),
        ("Комментарий AI", 44),
        ("Вопросы по пробелам", 50),
        ("Ссылка",     36),
    ]

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = vacancy["title"][:30]

    # ── Шапка с названием вакансии ────────────────────────────────────────────
    ws.merge_cells("A1:H1")
    title_cell = ws["A1"]
    title_cell.value = vacancy["title"]
    title_cell.font = Font(bold=True, size=13, color="1E293B")
    title_cell.alignment = Alignment(horizontal="left", vertical="center")
    ws.row_dimensions[1].height = 22

    if vacancy.get("requirements"):
        ws.merge_cells("A2:H2")
        req_cell = ws["A2"]
        req_cell.value = vacancy["requirements"]
        req_cell.font = Font(size=10, color="64748B")
        req_cell.alignment = Alignment(wrap_text=True, vertical="top")
        ws.row_dimensions[2].height = 40
        header_row = 3
    else:
        header_row = 2

    # ── Заголовки столбцов ────────────────────────────────────────────────────
    for col_idx, (col_name, col_width) in enumerate(COLUMNS, start=1):
        cell = ws.cell(row=header_row, column=col_idx, value=col_name)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = BORDER
        ws.column_dimensions[get_column_letter(col_idx)].width = col_width
    ws.row_dimensions[header_row].height = 20

    # ── Строки кандидатов ────────────────────────────────────────────────────
    for c in candidates:
        cat = c.get("category") or "pending"
        fill = FILLS.get(cat, FILLS["pending"])
        score_font = SCORE_FONT.get(cat, SCORE_FONT["pending"])
        questions_text = "\n".join(f"• {q}" for q in c["questions"]) if c["questions"] else ""

        data_row = [
            c.get("score"),
            CAT_LABELS.get(cat, cat),
            c.get("name") or "Кандидат",
            STATUS_LABELS.get(c.get("status", "new"), ""),
            c.get("summary") or "",
            c.get("ai_comment") or "",
            questions_text,
            c.get("hh_url") or "",
        ]

        r = ws.max_row + 1
        for col_idx, value in enumerate(data_row, start=1):
            cell = ws.cell(row=r, column=col_idx, value=value)
            cell.fill = fill
            cell.alignment = WRAP
            cell.border = BORDER
            if col_idx == 1:
                cell.font = score_font
                cell.alignment = Alignment(horizontal="center", vertical="top")
            if col_idx == 8 and value:  # ссылка
                cell.hyperlink = value
                cell.font = Font(color="2563EB", underline="single")

        # Примерная высота строки
        max_lines = max(
            len(str(data_row[4] or "").split("\n")),
            len(str(data_row[5] or "").split("\n")),
            len(str(data_row[6] or "").split("\n")),
            1
        )
        ws.row_dimensions[r].height = max(18, min(max_lines * 15, 90))

    # ── Закрепить заголовок ───────────────────────────────────────────────────
    ws.freeze_panes = ws.cell(row=header_row + 1, column=1)

    # ── Отдать файл ───────────────────────────────────────────────────────────
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    filename = f"candidates_{vacancy_id}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


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
