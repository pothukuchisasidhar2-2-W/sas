"""Offline test of ref_store harvest policy + schema (no camera/cv2 needed).

Run from the repo root:  python scripts/diag/test_ref_store.py
Exits non-zero on any failed assertion.
"""

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "db"))

import ref_store
from database import create_database

rng = np.random.default_rng(42)


def unit(vec):
    return (vec / np.linalg.norm(vec)).astype(np.float32)


def close(a, b, tol=1e-4):
    return abs(a - b) <= tol


failures = []


def check(label, ok):
    print(("PASS" if ok else "FAIL"), "-", label)
    if not ok:
        failures.append(label)


# --- schema: create on a fresh temp DB, and it is idempotent -------------
tmpdir = tempfile.mkdtemp(prefix="ref_store_test_")
db_path = os.path.join(tmpdir, "test.db")
create_database(db_path)
create_database(db_path)  # must not raise
conn = sqlite3.connect(db_path, timeout=5)

tables = {
    r[0]
    for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
}
check("students + attendance + student_embeddings exist",
      {"students", "attendance", "student_embeddings"} <= tables)

# --- seed one student ----------------------------------------------------
p = unit(rng.normal(size=128))
conn.execute(
    "INSERT INTO students (student_id, name, embedding) VALUES (?, ?, ?)",
    ("S1", "Test Student", p.tobytes()),
)
conn.commit()

harvest = ref_store.HarvestState(cooldown_sec=0.0)

# --- gate 1: low score is never stored ----------------------------------
q = unit(rng.normal(size=128))
action, _ = harvest.maybe_store(conn, "S1", q, ref_store.HARVEST_MIN_SCORE - 0.05)
check("below HARVEST_MIN_SCORE -> not stored", action is None)
check("  and nothing written to DB",
      conn.execute("SELECT COUNT(*) FROM student_embeddings").fetchone()[0] == 0)

# --- gate 2: high score, dissimilar -> stored ---------------------------
action, vec = harvest.maybe_store(conn, "S1", q, 0.60)
check("high score + dissimilar -> stored", action == "stored")
check("  stored vector is unit length", close(float(np.linalg.norm(vec)), 1.0))
check("  DB now has 1 reference",
      conn.execute("SELECT COUNT(*) FROM student_embeddings").fetchone()[0] == 1)

# --- gate 3: near-duplicate of an existing embedding -> skipped ----------
dup = ref_store.normalize(vec + 0.001 * rng.normal(size=128).astype(np.float32))
action, _ = harvest.maybe_store(conn, "S1", dup, 0.9)
check("near-duplicate of stored ref -> not stored", action is None)
check("  DB still has 1 reference",
      conn.execute("SELECT COUNT(*) FROM student_embeddings").fetchone()[0] == 1)

# --- gate 4: near-duplicate of the REGISTRATION embedding -> skipped -----
near_primary = ref_store.normalize(p + 0.001 * rng.normal(size=128).astype(np.float32))
action, _ = harvest.maybe_store(conn, "S1", near_primary, 0.9)
check("near-duplicate of registration embedding -> not stored", action is None)

# --- gate 5: cooldown ----------------------------------------------------
harvest2 = ref_store.HarvestState(cooldown_sec=3600.0)
r2 = unit(rng.normal(size=128))
a1, _ = harvest2.maybe_store(conn, "S1", r2, 0.7)
a2, _ = harvest2.maybe_store(conn, "S1", unit(rng.normal(size=128)), 0.7)
check("cooldown: first call stores, second blocked",
      a1 == "stored" and a2 is None)

# --- gate 6: unknown student -> skipped ----------------------------------
action, _ = harvest.maybe_store(conn, "GHOST", unit(rng.normal(size=128)), 0.99)
check("unknown student -> not stored", action is None)

# --- gate 7: cap at MAX_REFERENCES ---------------------------------------
def ref_count():
    return conn.execute(
        "SELECT COUNT(*) FROM student_embeddings WHERE student_id='S1'"
    ).fetchone()[0]


harvest3 = ref_store.HarvestState(cooldown_sec=0.0)
for _ in range(20):
    if ref_count() >= ref_store.MAX_REFERENCES:
        break
    harvest3.maybe_store(conn, "S1", unit(rng.normal(size=128)), 0.6)
check(f"fills up to MAX_REFERENCES={ref_store.MAX_REFERENCES}",
      ref_count() == ref_store.MAX_REFERENCES)

# at cap: a candidate that adds nothing new is refused. Deterministic
# "mediocre" pick: the blend of two stored refs (cos ~0.71 to both, far
# above any worst-ref redundancy, far below the duplicate threshold).
_r1, _r2 = ref_store.load_student_references(conn, "S1")[:2]
before = ref_count()
a, _ = harvest3.maybe_store(
    conn, "S1", ref_store.normalize(_r1 + _r2), 0.6
)
check("at cap, non-improving candidate -> not stored", a is None)
check("  count unchanged", ref_count() == before)

# at cap: a clearly-better (more diverse) candidate replaces the worst ref.
# Pick, deterministically, the candidate with the lowest similarity to
# everything the student already has, then verify the documented rule:
# it is replaced iff that similarity beats the worst stored reference by
# more than REDUNDANCY_MARGIN.
_primary, _refs = ref_store._load_embeddings(conn, "S1")
_existing = [_primary] + [v for _, v in _refs]
worst_redundancy = max(
    max(float(np.dot(rv, other))
        for other in ([_primary] + [v for i, v in _refs if i != rid]))
    for rid, rv in _refs
)

best_new, best_sim = None, 1.0
for _ in range(2000):
    cand = unit(rng.normal(size=128))
    sim = max(float(np.dot(cand, e)) for e in _existing)
    if sim < best_sim:
        best_new, best_sim = cand, sim

check("searched candidate is genuinely more diverse than worst ref",
      best_sim < worst_redundancy - ref_store.REDUNDANCY_MARGIN)
a, _ = harvest3.maybe_store(conn, "S1", best_new, 0.6)
check("at cap, more-diverse candidate replaces worst ref",
      a == "replaced" and ref_count() == ref_store.MAX_REFERENCES)

# --- best_match: correct student wins across primary+refs -----------------
conn.execute(
    "INSERT INTO students (student_id, name, embedding) VALUES (?, ?, ?)",
    ("S2", "Second Student", unit(rng.normal(size=128)).tobytes()),
)
conn.commit()

rows = []
for sid, name, blob in conn.execute(
    "SELECT student_id, name, embedding FROM students"
):
    rows.append(ref_store.as_match_rows(sid, name, np.frombuffer(blob, np.float32)))
    for v in ref_store.load_student_references(conn, sid):
        rows.append(ref_store.as_match_rows(sid, name, v))

check("more rows than students (refs loaded)",
      len(rows) > conn.execute("SELECT COUNT(*) FROM students").fetchone()[0])

# A query drawn tightly around S1's registration embedding must pick S1,
# and must beat every other stored row by a clear margin. (In 128 dims,
# per-component noise of 0.05 already drops cosine to ~0.87, so assert
# against the margin, not an absolute 0.9.)
query = ref_store.normalize(p + 0.05 * rng.normal(size=128).astype(np.float32))
score, sid, _name = ref_store.best_match(rows, query)
matrix = np.concatenate([r[2] for r in rows], axis=0)
all_scores = matrix @ ref_store.normalize(query).reshape(-1)
runner_up = float(np.sort(all_scores)[-2])
check("best_match picks the right student",
      sid == "S1" and score >= 0.8 and score - runner_up >= 0.5)

# --- clear_student (and its legacy-DB no-op) ------------------------------
ref_store.clear_student(conn, "S1")
check("clear_student wipes references",
      conn.execute(
          "SELECT COUNT(*) FROM student_embeddings WHERE student_id='S1'"
      ).fetchone()[0] == 0)

legacy = sqlite3.connect(os.path.join(tmpdir, "legacy.db"))
legacy.execute("CREATE TABLE students (student_id TEXT PRIMARY KEY)")
try:
    ref_store.clear_student(legacy, "S1")
    check("clear_student no-ops on DB without the table", True)
except sqlite3.OperationalError:
    check("clear_student no-ops on DB without the table", False)

conn.close()
legacy.close()

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("All checks passed.")
