import firebase_admin
from firebase_admin import credentials, firestore
from pathlib import Path

# Project folder
BASE_DIR = Path(__file__).resolve().parent
KEY_DIR = BASE_DIR / "secretkeys"

# Find the new Firebase service-account JSON file
json_files = list(KEY_DIR.glob("*.json"))

if not json_files:
    raise FileNotFoundError(
        f"No Firebase JSON key found inside: {KEY_DIR}"
    )

if len(json_files) > 1:
    raise RuntimeError(
        "More than one JSON file found in secretkeys. "
        "Keep only your new Firebase service-account JSON file there."
    )

KEY_PATH = json_files[0]

# Connect to Firebase
if not firebase_admin._apps:
    credential = credentials.Certificate(str(KEY_PATH))
    firebase_admin.initialize_app(credential)

db = firestore.client()

print("Firebase database connected successfully!")


def add_student(student_id, name):
    db.collection("Student").document(student_id).set({
        "student_id": student_id,
        "name": name
    })


def get_students():
    return [
        doc.to_dict()
        for doc in db.collection("Student").stream()
    ]


def update_student(student_id, name):
    db.collection("Student").document(student_id).update({
        "name": name
    })


def delete_student(student_id):
    db.collection("Student").document(student_id).delete()
