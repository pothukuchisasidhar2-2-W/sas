
import sqlite3
from pathlib import Path

db_path = Path(__file__).resolve().parent / "attendance.db"

connection = sqlite3.connect(db_path)

tables = connection.execute(
    "SELECT name FROM sqlite_master WHERE type='table'"
).fetchall()

print("Database path:", db_path)
print("Tables found:", tables)

connection.close()
