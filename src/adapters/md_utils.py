"""Shared helpers for markdown-table sources."""

from __future__ import annotations

import re

_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]+)[^)]*\)")
_HTML_ANCHOR_RE = re.compile(r'<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.I | re.S)
_TAG_RE = re.compile(r"<[^>]+>")


def split_row(line: str) -> list[str]:
    """Split a `| a | b |` table row into stripped cells."""
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


def is_separator_row(cells: list[str]) -> bool:
    return all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c)


def md_link(cell: str) -> tuple[str, str | None]:
    """Extract (text, url) from a markdown link cell like **[Text](url)**.
    Falls back to (plain text, None)."""
    m = _MD_LINK_RE.search(cell)
    if m:
        return m.group(1).strip().strip("*").strip(), m.group(2)
    return plain_text(cell), None


def html_anchor(cell: str) -> tuple[str, str | None]:
    """Extract (inner text, href) from an HTML anchor cell."""
    m = _HTML_ANCHOR_RE.search(cell)
    if m:
        return plain_text(m.group(2)), m.group(1)
    return plain_text(cell), None


def plain_text(cell: str) -> str:
    """Strip html tags, markdown bold, and collapse whitespace."""
    s = _TAG_RE.sub(" ", cell)
    s = s.replace("**", "").replace("*", "")
    return re.sub(r"\s+", " ", s).strip()


def iter_tables(lines: list[str]):
    """Yield (header_cells, [row_cells, ...]) for every markdown table found."""
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i].strip()
        if line.startswith("|") and i + 1 < n:
            header = split_row(line)
            sep = split_row(lines[i + 1].strip()) if lines[i + 1].strip().startswith("|") else []
            if sep and is_separator_row(sep):
                rows = []
                j = i + 2
                while j < n and lines[j].strip().startswith("|"):
                    rows.append(split_row(lines[j].strip()))
                    j += 1
                yield header, rows
                i = j
                continue
        i += 1
