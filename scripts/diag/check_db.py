import sqlite3
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DB_PATH = str(PROJECT_ROOT / "attendance.db")

connection = sqlite3.connect(DB_PATH)
cursor = connection.cursor()

# Older databases predate the reference-harvesting table; treat that as
# "zero references" instead of crashing.
has_reference_table = cursor.execute(
    """
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='student_embeddings'
    LIMIT 1
    """
).fetchone() is not None

cursor.execute("SELECT student_id, name, length(embedding) FROM students")

students = cursor.fetchall()

print("\nRegistered students:")
print("-" * 50)

total_references = 0

for student_id, name, embedding_size in students:
    print("Student ID :", student_id)
    print("Name       :", name)
    print("Embedding size:", embedding_size, "bytes")

    if has_reference_table:
        count = cursor.execute(
            "SELECT COUNT(*) FROM student_embeddings WHERE student_id = ?",
            (student_id,),
        ).fetchone()[0]
        total_references += count
        print("Harvested references:", count)
    else:
        print("Harvested references: 0 (reference table not created yet)")

    print("-" * 50)

if has_reference_table:
    print(f"Total harvested references: {total_references}")

connection.close()