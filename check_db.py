import sqlite3

connection = sqlite3.connect("attendance.db")
cursor = connection.cursor()

cursor.execute("SELECT student_id, name, length(embedding) FROM students")

students = cursor.fetchall()

print("\nRegistered students:")
print("-" * 50)

for student_id, name, embedding_size in students:
    print("Student ID :", student_id)
    print("Name       :", name)
    print("Embedding size:", embedding_size, "bytes")
    print("-" * 50)

connection.close()