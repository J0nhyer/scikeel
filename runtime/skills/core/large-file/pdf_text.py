#!/usr/bin/env python3
"""Open Science — bounded PDF text extraction with pypdf.

Companion to large_file_probe.py. Extracts text from a downloaded open-access
PDF into stdout or a workspace file under `papers/text/`. The extraction is
read-only (pypdf never writes the source PDF), bounded by --max-bytes (default
2 MiB), and never returns raw PDF bytes to the model.

When the PDF has no text layer (a scanned/image-only document), the helper
reports `status: "scanned"` instead of inventing text. OCR is out of scope.

Usage:
    python pdf_text.py PAPERS/ID.pdf [--pages A-B] [--out papers/text/id.txt]
    python pdf_text.py PAPERS/ID.pdf --pages 1-4          # text to stdout
Output:
    --out given  -> one compact JSON summary on stdout; text is written to --out.
    --out absent -> the bounded extracted text on stdout (`scanned` as JSON).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DEFAULT_MAX_BYTES = 2 * 1024 * 1024  # 2 MiB of extracted text per call
PAGE_MARKER = "--- page {page} ---"


def fail(message: str, **extra: object) -> int:
    print(json.dumps({"status": "unavailable", "reason": message, **extra}, ensure_ascii=False))
    return 2


def parse_pages(value: str | None, total: int) -> tuple[int, int]:
    """Parse a 1-based page range such as ``1-4`` or ``3``; clamp the end."""
    if not value:
        return 1, total
    text = value.strip()
    try:
        if "-" in text:
            first_text, last_text = text.split("-", 1)
            first = int(first_text) if first_text.strip() else 1
            last = int(last_text) if last_text.strip() else total
        else:
            first = last = int(text)
    except ValueError as e:
        raise ValueError(f"invalid page range: {value}") from e
    if first < 1 or last < first or first > total:
        raise ValueError(f"page range {value} is outside 1-{total}")
    return first, min(last, total)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Extract bounded text from a PDF with pypdf.")
    parser.add_argument("pdf", help="path to the downloaded PDF")
    parser.add_argument("--pages", help="1-based page range, for example 1-4")
    parser.add_argument("--out", help="write extracted text here (for example papers/text/ID.txt)")
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES,
                        help=f"cap on extracted text bytes (default {DEFAULT_MAX_BYTES})")
    args = parser.parse_args(argv)
    if args.max_bytes < 1:
        return fail("--max-bytes must be positive")

    path = Path(args.pdf)
    if not path.is_file():
        return fail(f"no such file: {path}")
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return fail("pypdf is not installed",
                    hint="install `pypdf` (pinned in the worker image) to extract PDF text")

    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:
                return fail("encrypted PDF; save an unlocked copy before extracting text")
        total = len(reader.pages)
    except Exception as e:  # degrade to a pointer, never crash
        return fail(f"cannot read PDF: {str(e)[:200]}")
    if total == 0:
        return fail("PDF has no pages")

    try:
        first, last = parse_pages(args.pages, total)
    except ValueError as e:
        return fail(str(e), pages=total)

    parts: list[str] = []
    used = 0
    characters = 0
    text_pages = 0
    failed_pages = 0
    truncated = False
    for number in range(first, last + 1):
        try:
            text = reader.pages[number - 1].extract_text() or ""
        except Exception:
            failed_pages += 1
            text = ""
        if text.strip():
            text_pages += 1
        block = f"{PAGE_MARKER.format(page=number)}\n{text.rstrip()}\n"
        encoded = block.encode("utf-8")
        if used + len(encoded) > args.max_bytes:
            remaining = args.max_bytes - used
            if remaining > 0:
                parts.append(encoded[:remaining].decode("utf-8", errors="ignore"))
                characters += len(parts[-1])
                used = args.max_bytes
            truncated = True
            break
        parts.append(block)
        characters += len(text)
        used += len(encoded)

    body = "".join(parts)
    if text_pages == 0:
        print(json.dumps({
            "status": "scanned",
            "pages": total,
            "pages_selected": f"{first}-{last}",
            "characters": 0,
            "hint": "no text layer found; OCR is out of scope",
        }, ensure_ascii=False))
        return 0

    summary: dict[str, object] = {
        "status": "pdf-text",
        "pages": total,
        "pages_selected": f"{first}-{last}",
        "characters": characters,
        "bytes": used,
        "max_bytes": args.max_bytes,
        "truncated": truncated,
    }
    if failed_pages:
        summary["failed_pages"] = failed_pages
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(body, encoding="utf-8")
        summary["out"] = str(out)
        print(json.dumps(summary, ensure_ascii=False))
    else:
        sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
