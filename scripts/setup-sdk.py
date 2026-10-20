#!/usr/bin/env python3
"""Fetch pinned official Google Android tools into this project (macOS only)."""
from pathlib import Path
import hashlib
import os
import platform
import stat
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = [
    ("platform-35_r02.zip", 64273788, "0bb560a90a7a2cbd0dd8348224d518b638fe7949", "android-35/android.jar"),
    ("build-tools_r35_macosx.zip", 76857898, "93ab8ce91230e067b5add4bfa79919c52b27f072", "android-15/aapt2"),
]

def valid(path, size, digest):
    return path.exists() and path.stat().st_size == size and hashlib.sha1(path.read_bytes()).hexdigest() == digest

def main():
    if platform.system() != "Darwin":
        raise SystemExit("This pinned setup currently supports macOS only.")
    vendor = ROOT / "vendor"
    sdk = vendor / "sdk"
    sdk.mkdir(parents=True, exist_ok=True)
    for name, size, digest, marker in PACKAGES:
        archive = vendor / name
        if not valid(archive, size, digest):
            temporary = archive.with_suffix(".zip.part")
            print("Downloading official Google package:", name, flush=True)
            with urllib.request.urlopen("https://dl.google.com/android/repository/" + name, timeout=60) as response, temporary.open("wb") as output:
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    output.write(block)
            if not valid(temporary, size, digest):
                raise SystemExit("Size or SHA-1 mismatch; nothing extracted: " + name)
            os.replace(temporary, archive)
        if (sdk / marker).exists():
            print("Verified archive, SDK already present:", name)
            continue
        with zipfile.ZipFile(archive) as source:
            for entry in source.infolist():
                target = (sdk / entry.filename).resolve()
                if not target.is_relative_to(sdk.resolve()) or stat.S_ISLNK(entry.external_attr >> 16):
                    raise SystemExit("Unsafe archive entry: " + entry.filename)
            source.extractall(sdk)
            for entry in source.infolist():
                mode = entry.external_attr >> 16
                if mode and not entry.is_dir():
                    (sdk / entry.filename).chmod(mode & 0o777)
        print("Verified and extracted:", name)

if __name__ == "__main__":
    main()
