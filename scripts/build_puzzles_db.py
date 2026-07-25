#!/usr/bin/env python3
"""
build_puzzles_db.py: Lichess puzzle CSV(.zst) -> bundled read-only SQLite.

Implements docs/architecture.md §5.2 with the adversarial review's refinement:
  decompress (zstd long window) -> validate header -> THEME-AWARE prune ->
  puzzles table + puzzle_themes covering junction -> indexes -> ANALYZE/VACUUM.

Theme-aware prune: rich themes are pruned by popularity/plays; puzzles carrying a
"thin" theme are ALWAYS kept so rare-theme lesson pools don't get starved.

Zstd decompression uses the stdlib `compression.zstd` on Python 3.14+, and falls
back to the third-party `zstandard` package on older interpreters (e.g. the
macOS system Python 3.9), so the build runs on any platform. sqlite3 + csv are
stdlib. No native build deps.
Output: resources/data/puzzles.sqlite (git-ignored; rebuilt from the raw download).
"""
import csv
import io
import os
import sqlite3
import sys
import time

# Long-window zstd, decompressed as a UTF-8 text stream. Prefer the 3.14+ stdlib;
# fall back to `zstandard` (pip) on older Pythons; otherwise fail with guidance.
try:
    import compression.zstd as _zstd
    from compression.zstd import DecompressionParameter as _DP

    def _open_zst_text(src):
        return _zstd.open(src, "rt", encoding="utf-8", newline="",
                          options={_DP.window_log_max: 31})
except ImportError:
    try:
        import zstandard as _zstandard
    except ImportError:
        _zstandard = None

    def _open_zst_text(src):
        if _zstandard is None:
            sys.exit(
                "zstd support missing. Use Python 3.14+ (stdlib compression.zstd) "
                "or run `pip install zstandard`."
            )
        dctx = _zstandard.ZstdDecompressor(max_window_size=2 ** 31)
        return io.TextIOWrapper(dctx.stream_reader(open(src, "rb")),
                                encoding="utf-8", newline="")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "raw", "lichess_db_puzzle.csv.zst")
OUT_DIR = os.path.join(ROOT, "resources", "data")
OUT = os.path.join(OUT_DIR, "puzzles.sqlite")

EXPECTED_HEADER = [
    "PuzzleId", "FEN", "Moves", "Rating", "RatingDeviation",
    "Popularity", "NbPlays", "Themes", "GameUrl", "OpeningTags",
]

MIN_PLAYS = 50          # rich-theme prune: minimum NbPlays
MIN_POPULARITY = 80     # rich-theme prune: minimum Popularity (-100..100 scale)
THIN_THEME_MAX = 20000  # a theme with fewer total puzzles than this is "thin" -> keep all


def open_csv():
    return _open_zst_text(SRC)


def main():
    if not os.path.exists(SRC):
        sys.exit(f"missing {SRC} (run `npm run setup:puzzles` first)")
    os.makedirs(OUT_DIR, exist_ok=True)
    csv.field_size_limit(1 << 20)
    t0 = time.time()

    # ---- Pass 1: validate header + count puzzles per theme ----
    theme_counts: dict[str, int] = {}
    total = 0
    malformed = 0
    with open_csv() as f:
        r = csv.reader(f)
        header = next(r)
        if header != EXPECTED_HEADER:
            sys.exit(f"header drift:\n got {header}\n exp {EXPECTED_HEADER}")
        for row in r:
            if len(row) != 10:
                malformed += 1
                continue
            total += 1
            themes = row[7]
            if themes:
                for th in themes.split(" "):
                    if th:
                        theme_counts[th] = theme_counts.get(th, 0) + 1
            if total % 1_000_000 == 0:
                print(f"  pass1 {total:,} rows...", flush=True)
    thin = {t for t, c in theme_counts.items() if c < THIN_THEME_MAX}
    print(f"pass1: {total:,} puzzles | {len(theme_counts)} themes | "
          f"{len(thin)} thin | {malformed} malformed | {time.time() - t0:.0f}s", flush=True)

    # ---- Create schema ----
    if os.path.exists(OUT):
        os.remove(OUT)
    con = sqlite3.connect(OUT)
    cur = con.cursor()
    cur.executescript(
        """
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        PRAGMA temp_store=MEMORY;
        CREATE TABLE puzzles(
          PuzzleId TEXT PRIMARY KEY, FEN TEXT NOT NULL, Moves TEXT NOT NULL,
          Rating INTEGER NOT NULL, RatingDeviation INTEGER, Popularity INTEGER,
          NbPlays INTEGER, Themes TEXT, GameUrl TEXT, OpeningTags TEXT);
        CREATE TABLE puzzle_themes(Theme TEXT, Rating INTEGER, PuzzleId TEXT);
        """
    )

    # ---- Pass 2: prune + insert ----
    kept = 0
    pbatch: list = []
    tbatch: list = []

    def flush():
        nonlocal pbatch, tbatch
        if pbatch:
            cur.executemany("INSERT INTO puzzles VALUES(?,?,?,?,?,?,?,?,?,?)", pbatch)
            pbatch = []
        if tbatch:
            cur.executemany("INSERT INTO puzzle_themes VALUES(?,?,?)", tbatch)
            tbatch = []

    with open_csv() as f:
        r = csv.reader(f)
        next(r)  # skip header
        for row in r:
            if len(row) != 10:
                continue
            pid, fen, moves, rating, rd, pop, plays, themes, url, otags = row
            rating_i = int(rating) if rating else 0
            pop_i = int(pop) if pop else 0
            plays_i = int(plays) if plays else 0
            theme_list = [t for t in themes.split(" ") if t] if themes else []
            has_thin = any(t in thin for t in theme_list)
            if not ((plays_i >= MIN_PLAYS and pop_i >= MIN_POPULARITY) or has_thin):
                continue
            pbatch.append((pid, fen, moves, rating_i, int(rd) if rd else None,
                           pop_i, plays_i, themes, url, otags))
            for t in theme_list:
                tbatch.append((t, rating_i, pid))
            kept += 1
            if len(pbatch) >= 50_000:
                flush()
    flush()
    con.commit()
    print(f"pass2: kept {kept:,} / {total:,} ({100 * kept / max(total,1):.1f}%) | "
          f"{time.time() - t0:.0f}s", flush=True)

    # ---- Indexes + optimize ----
    cur.executescript(
        """
        CREATE INDEX idx_pt ON puzzle_themes(Theme, Rating, PuzzleId);
        CREATE INDEX idx_rating ON puzzles(Rating);
        """
    )
    con.commit()
    cur.execute("ANALYZE")
    con.commit()
    cur.execute("PRAGMA journal_mode=DELETE")  # safe mode before VACUUM
    con.commit()
    cur.execute("VACUUM")
    con.commit()

    nj = cur.execute("SELECT COUNT(*) FROM puzzle_themes").fetchone()[0]
    con.close()
    size_mb = os.path.getsize(OUT) / 1e6
    print(f"DONE -> {OUT}")
    print(f"  puzzles={kept:,} | junction_rows={nj:,} | size={size_mb:.0f} MB | "
          f"total_time={time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
