import sqlite3

DB_PATH = "attendance.db"


def create_database(db_path=DB_PATH):
    """Create the attendance database tables if they are missing.

    Call this once at startup or from a deployment/seed script. The tables
    are guarded by OPEN IF NOT EXISTS, so running this against an existing
    database is safe.
    """
    connection = sqlite3.connect(db_path, timeout=5)
    connection.execute("PRAGMA journal_mode=WAL")

    connection.execute("""
        CREATE TABLE IF NOT EXISTS students (
            student_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            embedding BLOB NOT NULL
        )
    """)

    connection.execute("""
        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            date TEXT NOT NULL,
            in_time TEXT,
            out_time TEXT
        )
    """)

    # Reference embeddings harvested during live recognition. Registration
    # still stores exactly one canonical embedding per student in `students`;
    # this table holds a small capped set of extra views captured only when
    # they add genuinely new information (see scripts/core/ref_store.py).
    connection.execute("""
        CREATE TABLE IF NOT EXISTS student_embeddings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            embedding BLOB NOT NULL,
            source TEXT NOT NULL DEFAULT 'recognition',
            created_at TEXT NOT NULL
        )
    """)

    connection.execute("""
        CREATE INDEX IF NOT EXISTS idx_student_embeddings_student
        ON student_embeddings(student_id)
    """)

    connection.commit()
    connection.close()


if __name__ == "__main__":
    create_database()
    print("Database created successfully!")