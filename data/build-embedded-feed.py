from __future__ import annotations

import base64
import json
from pathlib import Path


DATA_DIR = Path(__file__).resolve().parent
ARCHIVE = DATA_DIR / "Google_transit.zip"
OUTPUT = DATA_DIR / "Google_transit-embedded.js"
CHUNK_SIZE = 12_000


def main() -> None:
    encoded = base64.b64encode(ARCHIVE.read_bytes()).decode("ascii")
    with OUTPUT.open("w", encoding="ascii", newline="\n") as output:
        output.write("window.TITSA_GTFS_ARCHIVE_B64 =\n")
        for start in range(0, len(encoded), CHUNK_SIZE):
            chunk = encoded[start : start + CHUNK_SIZE]
            is_last = start + CHUNK_SIZE >= len(encoded)
            output.write(json.dumps(chunk))
            output.write(";\n" if is_last else " +\n")


if __name__ == "__main__":
    main()
