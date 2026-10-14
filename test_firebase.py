print("Testing Firebase connection...")

try:
    from firebase_db import db, add_student, get_students

    print("Firebase connection successful!")

    # Write a test student to Firestore
    add_student("TEST001", "Firebase Connection Test")
    print("Test student saved successfully!")

    # Read students from Firestore
    students = get_students()

    print("\nStudents in Firestore:")
    for student in students:
        print(
            student.get("student_id"),
            "-",
            student.get("name")
        )

    print("\nSUCCESS: Firebase read and write both work!")

except Exception as error:
    print("\nFirebase connection failed.")
    print("Error type:", type(error).__name__)
    print("Error details:", error)

input("\nPress Enter to close...")
