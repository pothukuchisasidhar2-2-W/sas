"""Reference-embedding harvesting for live recognition.

Registration (register.py) stores exactly ONE canonical embedding per
student. During live recognition, repeated high-confidence matches can
teach the system new poses and lighting conditions -- but only when they
add genuinely new information. All harvest policy lives here:

  * only harvest faces that matched with high confidence (well above the
    0.363 recognition threshold -- we never learn from a maybe-identity),
  * skip near-duplicates (cosine >= 0.97 against anything the student
    already has, including the registration embedding),
  * keep at most MAX_REFERENCES harvested embeddings per student,
  * at the cap, replace the most redundant stored reference only if the
    candidate is meaningfully more diverse.

No cv2 import: this module is pure sqlite3 + numpy so it can be tested
without a camera.
"""

import sqlite3
import time
from datetime import datetime

import numpy as np

MAX_REFERENCES = 4            # harvested refs per student (primary is extra)
HARVEST_MIN_SCORE = 0.55      # cosine score required before we learn a face
REDUNDANCY_THRESHOLD = 0.97   # >= this sim to an existing embedding = duplicate
REDUNDANCY_MARGIN = 0.02      # at cap: candidate must beat worst ref by this

CREATE_SCHEMA = """
    CREATE TABLE IF NOT EXISTS student_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        embedding BLOB NOT NULL,
        source TEXT NOT NULL DEFAULT 'recognition',
        created_at TEXT NOT NULL
    )
"""

CREATE_INDEX = """
    CREATE INDEX IF NOT EXISTS idx_student_embeddings_student
    ON student_embeddings(student_id)
"""


def ensure_schema(conn):
    """Create the reference table + index if missing (idempotent)."""
    conn.execute(CREATE_SCHEMA)
    conn.execute(CREATE_INDEX)
    conn.commit()


def normalize(vector):
    """Return a unit-length 1-D float32 copy of an SFace embedding."""
    vec = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vec))
    if norm > 0:
        vec = vec / norm
    return vec


def cosine(a, b):
    """Cosine similarity between two embeddings (order-insensitive)."""
    return float(np.dot(normalize(a), normalize(b)))


def as_match_rows(student_id, name, vector):
    """Build one (student_id, name, (1, D)) row for best_match()."""
    return (student_id, name, normalize(vector).reshape(1, -1))


def best_match(rows, live_vector):
    """Best (score, student_id, name) over all rows via one matvec.

    All rows are unit-normalized (as_match_rows guarantees this), and the
    live vector is normalized here, so the dot product equals the cosine
    similarity that cv2.FaceRecognizerSF_FR_COSINE would compute -- but
    vectorized across every student and every reference at once.
    """
    if not rows:
        return (-1.0, None, None)
    matrix = np.concatenate([row[2] for row in rows], axis=0)
    live = normalize(live_vector).reshape(-1)
    scores = matrix @ live
    idx = int(np.argmax(scores))
    return (float(scores[idx]), rows[idx][0], rows[idx][1])


class HarvestState:
    """Per-run harvest bookkeeping (per-student cooldown timers)."""

    def __init__(self, cooldown_sec=30.0):
        self.cooldown_sec = cooldown_sec
        self._last_attempt = {}

    def maybe_store(self, conn, student_id, live_vector, score):
        """Decide whether this recognized face deserves to become a reference.

        Returns (action, vec):
          action == 'stored' / 'replaced' -> vec is the new unit embedding
          action is None -> nothing stored (below score threshold, cooldown,
                            duplicate, at cap without improvement, or unknown
                            student)
        """
        if score < HARVEST_MIN_SCORE:
            return (None, None)

        now = time.monotonic()
        if now - self._last_attempt.get(student_id, float("-inf")) < self.cooldown_sec:
            return (None, None)
        self._last_attempt[student_id] = now

        candidate = normalize(live_vector)
        primary, refs = _load_embeddings(conn, student_id)
        if primary is None:
            return (None, None)

        existing = [primary] + [vec for _, vec in refs]
        best_sim = max(float(np.dot(candidate, vec)) for vec in existing)

        # Near-duplicate: this face adds nothing new.
        if best_sim >= REDUNDANCY_THRESHOLD:
            return (None, None)

        # Room left under the cap: keep it.
        if len(refs) < MAX_REFERENCES:
            _insert_reference(conn, student_id, candidate)
            return ("stored", candidate)

        # At the cap: swap only if the candidate is meaningfully more
        # diverse than the most redundant stored reference.
        worst_redundancy, worst_id = -1.0, None
        for ref_id, ref_vec in refs:
            others = [primary] + [v for i, v in refs if i != ref_id]
            redundancy = max(float(np.dot(ref_vec, other)) for other in others)
            if redundancy > worst_redundancy:
                worst_redundancy, worst_id = redundancy, ref_id

        if worst_id is not None and best_sim < worst_redundancy - REDUNDANCY_MARGIN:
            conn.execute("DELETE FROM student_embeddings WHERE id = ?", (worst_id,))
            _insert_reference(conn, student_id, candidate)
            conn.commit()
            return ("replaced", candidate)

        return (None, None)


def _load_embeddings(conn, student_id):
    """(primary unit vector, [(ref_id, unit vector), ...]) or (None, [])."""
    row = conn.execute(
        "SELECT embedding FROM students WHERE student_id = ?",
        (student_id,),
    ).fetchone()
    if row is None:
        return (None, [])
    primary = normalize(np.frombuffer(row[0], dtype=np.float32))
    refs = []
    for ref_id, blob in conn.execute(
        "SELECT id, embedding FROM student_embeddings WHERE student_id = ?",
        (student_id,),
    ):
        refs.append((ref_id, normalize(np.frombuffer(blob, dtype=np.float32))))
    return (primary, refs)


def _insert_reference(conn, student_id, vec):
    conn.execute(
        """
        INSERT INTO student_embeddings
            (student_id, embedding, source, created_at)
        VALUES (?, ?, 'recognition', ?)
        """,
        (
            student_id,
            vec.astype(np.float32).tobytes(),
            datetime.now().isoformat(timespec="seconds"),
        ),
    )
    conn.commit()


def load_all_references(conn):
    """[(student_id, unit 1-D vector)] for every harvested reference."""
    out = []
    for student_id, blob in conn.execute(
        "SELECT student_id, embedding FROM student_embeddings"
    ):
        out.append((student_id, normalize(np.frombuffer(blob, dtype=np.float32))))
    return out


def load_student_references(conn, student_id):
    """Unit 1-D vectors of one student's harvested references."""
    return [
        normalize(np.frombuffer(blob, dtype=np.float32))
        for (blob,) in conn.execute(
            "SELECT embedding FROM student_embeddings WHERE student_id = ?",
            (student_id,),
        )
    ]


def clear_student(conn, student_id):
    """Drop all harvested references for a student (used on re-registration).

    No-op if the reference table does not exist yet (legacy database that
    has not gone through ensure_schema()).
    """
    table_exists = conn.execute(
        """
        SELECT 1 FROM sqlite_master
        WHERE type='table' AND name='student_embeddings'
        LIMIT 1
        """
    ).fetchone()
    if table_exists is None:
        return

    conn.execute(
        "DELETE FROM student_embeddings WHERE student_id = ?",
        (student_id,),
    )
    conn.commit()
