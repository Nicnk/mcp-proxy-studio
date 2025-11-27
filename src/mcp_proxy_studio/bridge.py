import os, sys, shutil, subprocess, sysconfig, tempfile, urllib.request
from pathlib import Path


def _download_mjs(tmp_dir: Path) -> Path | None:
    ref = os.environ.get("REF") or "main"
    url = f"https://raw.githubusercontent.com/lucasiscovici/MCP-Proxy-Studio/{ref}/bin/mcps.mjs"
    dest = tmp_dir / "mcps.mjs"
    try:
        with urllib.request.urlopen(url, timeout=8) as resp:
            dest.write_bytes(resp.read())
        return dest
    except Exception:
        return None


def _find_mjs() -> Path | None:
    # Preferred: explicit override
    override = os.environ.get("MCPS_MJS_PATH")
    if override:
        candidate = Path(override)
        if candidate.exists():
            return candidate

    root = Path(__file__).resolve()
    candidates = [
        root.parents[2] / "bin" / "mcps.mjs",  # repo layout
        root.parent / "mcps.mjs",  # packaged alongside module if included
        Path(sysconfig.get_paths().get("purelib", "")) / "bin" / "mcps.mjs",
        Path(sysconfig.get_paths().get("scripts", "")) / "mcps.mjs",
    ]
    for cand in candidates:
        if cand.exists():
            return cand

    tmp_dir = Path(tempfile.mkdtemp(prefix="mcps-mjs-"))
    return _download_mjs(tmp_dir)


def main():
    node = shutil.which("node")
    if not node:
        print("Erreur: 'node' est requis (installe Node.js).", file=sys.stderr)
        raise SystemExit(127)

    mjs = _find_mjs()
    if not mjs.exists():
        print(f"Erreur: introuvable: {mjs}", file=sys.stderr)
        raise SystemExit(1)

    # on relaie args + env (REF, etc.)
    p = subprocess.run([node, str(mjs), *sys.argv[1:]], env=os.environ)
    raise SystemExit(p.returncode)
