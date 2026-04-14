import sqlite3
import json
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
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT NOT NULL,
            description TEXT NOT NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
            status      TEXT DEFAULT 'new',
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (vacancy_id) REFERENCES vacancies(id)
        );
    """)
    conn.commit()
    conn.close()


def row_to_dict(row):
    return dict(zip(row.keys(), row))
