#!/usr/bin/env python3
"""
fetch_engines.py: download + verify the Stockfish engine binary (v0).

Implements docs/architecture.md §6 with the review's provenance assertion:
download a PINNED Stockfish release, extract the binary, then UCI-PROBE it to
confirm it actually runs (verify by `uci`/`uciok`, not by filename).

Cross-platform and congruent: the SAME script serves Windows, macOS, and Linux.
It detects the host OS/arch, fetches the matching official Stockfish sf_18 asset
(a .zip on Windows, a .tar on macOS/Linux), extracts the engine into a
per-platform folder, and on Unix marks it executable:

  Windows : resources/engine/win/stockfish.exe
  macOS   : resources/engine/mac/stockfish
  Linux   : resources/engine/linux/stockfish

v0 fetches Stockfish only. lc0 + Maia (human-feel play) are deferred to Loop 2.

Stdlib only (urllib + zipfile + tarfile + subprocess). Output is git-ignored.

Override the microarch with SF_VARIANT. Defaults aim broad-but-fast:
  Windows / Linux / Intel macOS -> x86-64-avx2 (any CPU from ~2013 on)
  Apple Silicon macOS           -> the m1-apple-silicon build (ignores SF_VARIANT)
"""
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAG = "sf_18"
BASE = f"https://github.com/official-stockfish/Stockfish/releases/download/{TAG}"


def resolve_target():
    """Return (platform_dir, asset_name, kind, exe_name) for the host machine."""
    system = platform.system()
    machine = platform.machine().lower()
    variant = os.environ.get("SF_VARIANT", "x86-64-avx2")

    if system == "Windows":
        return "win", f"stockfish-windows-{variant}.zip", "zip", "stockfish.exe"

    if system == "Darwin":
        if machine in ("arm64", "aarch64"):
            asset = "stockfish-macos-m1-apple-silicon.tar"
        else:
            asset = f"stockfish-macos-{variant}.tar"
        return "mac", asset, "tar", "stockfish"

    if system == "Linux":
        return "linux", f"stockfish-ubuntu-{variant}.tar", "tar", "stockfish"

    sys.exit(f"unsupported platform: {system}/{machine}")


def download(url: str, dest: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "offline-chess-trainer-setup"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, length=1 << 20)


def extract_binary(archive: str, kind: str, dest_bin: str) -> None:
    """Pull the engine binary out of the downloaded archive to dest_bin."""
    if kind == "zip":
        with zipfile.ZipFile(archive) as z:
            member = next((n for n in z.namelist() if n.lower().endswith(".exe")), None)
            if not member:
                sys.exit(f"no .exe inside {archive}")
            with z.open(member) as src, open(dest_bin, "wb") as out:
                shutil.copyfileobj(src, out)
        return

    # tar: the binary is the executable file member whose basename starts with
    # "stockfish" and has no source/doc extension (e.g. stockfish/stockfish-macos-m1-apple-silicon).
    with tarfile.open(archive) as t:
        member = None
        for m in t.getmembers():
            if not m.isfile():
                continue
            base = os.path.basename(m.name)
            if base.startswith("stockfish") and "." not in base:
                member = m
                break
        if member is None:
            sys.exit(f"no stockfish binary inside {archive}")
        src = t.extractfile(member)
        if src is None:
            sys.exit(f"could not read {member.name} from {archive}")
        with src, open(dest_bin, "wb") as out:
            shutil.copyfileobj(src, out)


def uci_probe(exe: str) -> str:
    """Run the binary, exchange UCI, assert uciok. Returns the engine id line."""
    p = subprocess.Popen(
        [exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, encoding="utf-8",
    )
    out, _ = p.communicate(input="uci\nisready\nquit\n", timeout=30)
    if "uciok" not in out:
        sys.exit(f"UCI probe FAILED, no 'uciok' in engine output:\n{out[:500]}")
    id_line = next((ln for ln in out.splitlines() if ln.startswith("id name")), "id name <unknown>")
    return id_line.replace("id name ", "").strip()


def main():
    plat_dir, asset, kind, exe_name = resolve_target()
    url = f"{BASE}/{asset}"
    out_dir = os.path.join(ROOT, "resources", "engine", plat_dir)
    exe = os.path.join(out_dir, exe_name)
    tmp = os.path.join(ROOT, "data", "tmp")

    os.makedirs(tmp, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)
    t0 = time.time()

    archive = os.path.join(tmp, asset)
    print(f"downloading {url}", flush=True)
    download(url, archive)
    print(f"  got {os.path.getsize(archive) // 1024 // 1024} MB in {time.time() - t0:.0f}s", flush=True)

    if os.path.exists(exe):
        os.remove(exe)
    extract_binary(archive, kind, exe)
    os.remove(archive)
    if os.name != "nt":
        os.chmod(exe, 0o755)
    print(f"extracted -> {exe} ({os.path.getsize(exe) // 1024 // 1024} MB)", flush=True)

    engine_id = uci_probe(exe)
    print(f"UCI probe OK -> {engine_id}")
    print(f"DONE in {time.time() - t0:.0f}s")
    # TODO(packaging): also fetch the corresponding GPL source tarball into
    # resources/licenses/stockfish-src-sf_18.tar.gz for offline GPLv3 §6 compliance.


if __name__ == "__main__":
    main()
