/**
 * The app's content column, shared by every screen under the header so
 * nothing shifts sideways between tabs: 1360px wide, 32px side padding on
 * desktop and 16px on phones (the 700px breakpoint the Matches table and
 * header switch layouts at). A screen whose content is a lone form keeps its
 * own narrower max-width inside this column, left-aligned to the same edge
 * (FORM_COLUMN).
 */
export const PAGE_CONTAINER = "mx-auto w-full max-w-[1360px] px-4 min-[700px]:px-8";

/** A screen's page: the column plus the shared top and bottom spacing. */
export const PAGE = `${PAGE_CONTAINER} pt-5 pb-24 min-[700px]:pt-7`;

/** Matches: as PAGE, with room at the bottom for the fixed keyboard dock. */
export const PAGE_WITH_DOCK = `${PAGE_CONTAINER} pt-5 pb-32 min-[700px]:pt-7`;

/** Settings: every child of the page capped at the form's 640px. */
export const FORM_COLUMN = `${PAGE} *:max-w-[640px]`;
