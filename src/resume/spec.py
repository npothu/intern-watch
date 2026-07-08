"""Formatting spec shared by the renderer and the page-fit estimator.

One source of truth: if render.py and fit.py disagreed on a size or an
indent, the estimator would approve layouts the renderer then overflows.

All positions are in twips (1/20 pt, 1440/inch) to match OOXML; font sizes
are in points.
"""

from __future__ import annotations

# ---- page (US Letter, 0.5" margins) ----
PAGE_W_TW = 12240
PAGE_H_TW = 15840
MARGIN_TW = 720
CONTENT_W_TW = PAGE_W_TW - 2 * MARGIN_TW          # 10800 tw = 7.5 in = 540 pt
CONTENT_H_TW = PAGE_H_TW - 2 * MARGIN_TW          # 14400 tw = 10  in = 720 pt

FONT = "Times New Roman"

# ---- point sizes ----
SZ_NAME = 10.0
SZ_CONTACT = 10.0
SZ_SECTION = 13.0
SZ_EDU = 10.0
SZ_BODY = 11.0       # project/community headings, bullets, separator paras

LINK_COLOR = "1155CC"

# Single right-aligned tab stop at the right text edge. The old builder used
# literal "\t\t" against a ladder of left stops, so long headings pushed the
# date off-grid; one right stop is length-independent.
RIGHT_TAB_TW = CONTENT_W_TW

# ---- bullets: literal "●<tab>text" with a hanging indent ----
BULLET_CHAR = "●"
BULLET_INDENT_TW = 720      # wrapped lines align here
BULLET_HANG_TW = 360        # first line starts at 720-360, ● then tab to 720

# Section header bottom-border thickness, eighths of a point (w:sz).
SECTION_BORDER_SZ8 = 6
SECTION_SPACE_AFTER_PT = 2.0

# Word's single line spacing uses the font's design line height; for Times
# New Roman that is ~1.149 em (ascent 1825 + descent 443 + gap 87 over 2048).
LINE_HEIGHT_EM = 1.15


def tw_to_pt(tw: float) -> float:
    return tw / 20.0
