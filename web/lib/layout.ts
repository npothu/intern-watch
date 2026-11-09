/**
 * The app's content column, shared by every screen under the header so
 * nothing shifts sideways between tabs: 1360px wide, 32px side padding on
 * desktop and 16px on phones (the 700px breakpoint the Matches table and
 * header switch layouts at). A screen whose content is a lone form keeps its
 * own narrower max-width inside this column, left-aligned to the same edge.
 */
export const PAGE_CONTAINER = "mx-auto w-full max-w-[1360px] px-4 min-[700px]:px-8";
