import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "screening.db"


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS vacancies (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            title        TEXT NOT NULL,
            description  TEXT NOT NULL,
            requirements TEXT DEFAULT '',
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS candidates (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            vacancy_id  INTEGER NOT NULL,
            name        TEXT,
            hh_url      TEXT,
            resume_text TEXT,
            score       INTEGER,
            category    TEXT DEFAULT 'pending',
            ai_comment  TEXT,
            questions   TEXT,
            summary     TEXT DEFAULT '',
            status      TEXT DEFAULT 'new',
            is_trashed  INTEGER DEFAULT 0,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (vacancy_id) REFERENCES vacancies(id),
            UNIQUE(vacancy_id, hh_url)
        );
    """)
    # Миграция для существующих БД
    for sql in [
        "ALTER TABLE vacancies  ADD COLUMN requirements   TEXT DEFAULT ''",
        "ALTER TABLE candidates ADD COLUMN summary        TEXT DEFAULT ''",
        "ALTER TABLE candidates ADD COLUMN is_trashed     INTEGER DEFAULT 0",
        "ALTER TABLE candidates ADD COLUMN pros           TEXT DEFAULT '[]'",
        "ALTER TABLE candidates ADD COLUMN cons           TEXT DEFAULT '[]'",
        "ALTER TABLE candidates ADD COLUMN score_breakdown TEXT DEFAULT '[]'",
        # Обнуляем NULL → 0 перед дедупликацией
        "UPDATE candidates SET is_trashed = 0 WHERE is_trashed IS NULL",
        # Дедупликация: если есть и трэшированная, и живая версия — удаляем трэш;
        # если несколько живых — оставляем с наибольшим id
        """DELETE FROM candidates WHERE id IN (
            SELECT c1.id FROM candidates c1
            WHERE (
                c1.is_trashed = 1
                AND EXISTS (
                    SELECT 1 FROM candidates c2
                    WHERE c2.vacancy_id = c1.vacancy_id
                    AND c2.hh_url = c1.hh_url
                    AND c2.is_trashed = 0
                )
            ) OR (
                c1.is_trashed = 0
                AND c1.id < (
                    SELECT MAX(c3.id) FROM candidates c3
                    WHERE c3.vacancy_id = c1.vacancy_id
                    AND c3.hh_url = c1.hh_url
                    AND c3.is_trashed = 0
                )
            )
        )""",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates_vacancy_url ON candidates(vacancy_id, hh_url)",
        "ALTER TABLE vacancies ADD COLUMN boolean_search TEXT DEFAULT ''",
        "ALTER TABLE vacancies ADD COLUMN metrics TEXT DEFAULT '[]'",
    ]:
        try:
            conn.execute(sql)
            conn.commit()
        except Exception:
            pass
    conn.close()


def row_to_dict(row):
    return dict(zip(row.keys(), row))
