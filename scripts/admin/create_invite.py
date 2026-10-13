"""Issue one-time teacher activation codes from the local operator console."""
from __future__ import annotations

import json
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from api.main import connect, digest_token, init_db, now_iso  # noqa: E402


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] != "teacher":
        raise SystemExit("Usage: python scripts/admin/create_invite.py teacher")
    role = "teacher"
    init_db()
    payload = {"departmentName": input("Department name (optional): ").strip(), "assignments": []}
    print("Enter each authorized subject as code|name|branch|year|section. Leave blank when finished.")
    while line := input("Assignment: ").strip():
        parts = [item.strip() for item in line.split("|")]
        if len(parts) != 5 or not all(parts):
            print("Expected exactly: code|name|branch|year|section")
            continue
        try:
            year = int(parts[3])
            if not 1 <= year <= 8:
                raise ValueError
        except ValueError:
            print("Year must be an integer between 1 and 8.")
            continue
        payload["assignments"].append({"subjectCode": parts[0].upper(), "subjectName": parts[1],
            "branch": parts[2].upper(), "year": year, "section": parts[4].upper()})
    if not payload["assignments"]:
        raise SystemExit("A teacher invitation must include at least one authorized teaching assignment.")
    code = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(days=7)).replace(microsecond=0).isoformat()
    with connect() as db:
        db.execute("INSERT INTO activation_invites(code_hash,role,payload,expires_at,created_at) VALUES (?,?,?,?,?)",
            (digest_token(code), role, json.dumps(payload), expires, now_iso()))
    print("\nOne-time activation code (share directly with the intended person):")
    print(code)
    print(f"Expires: {expires}")


if __name__ == "__main__":
    main()
