"use client";

// Resume profile editor. The profile is a bank JSON string (the shape inside
// users/<user>_resume.json / convex/resume_docx.ts `Profile`): header,
// education, skills, work_experience, projects (Record<string, Project> with
// {tech?, date, tags?, bullets: Record<variant, string[]>}), community.
//
// ROUND-TRIP RULE: the working copy is the parsed object itself, mutated in
// place and serialized back from the SAME object. Unknown keys the user
// authored are never touched, so they survive. Skill lines are only re-split
// into plain strings when the user actually edits that line - untouched lines
// keep their exact original entries (including {name, keywords} objects).

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Save, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { saveProfile } from "@/app/(app)/profile/profile-actions";

// -- local shape mirrors ----------------------------------------------------
// The web bundle can't import the `Profile` type from ../../convex, so the
// edited surfaces are typed here. The root keeps its index signature so any
// user-authored keys outside this shape survive the round trip.

type SkillItem = string | { name: string; keywords?: string[] };

type ProjectLike = {
  [key: string]: unknown;
  tech?: string[];
  date: string;
  tags?: string[];
  bullets: Record<string, string[]>;
};

type ProfileObj = {
  [key: string]: unknown;
  header: { [key: string]: unknown; name: string; contact_line: string };
  education: {
    [key: string]: unknown;
    institution: string;
    grad_date: string;
    degree?: string;
    gpa?: string;
  };
  skills?: {
    [key: string]: unknown;
    languages?: SkillItem[];
    tools?: SkillItem[];
    coursework?: SkillItem[];
  };
  projects?: Record<string, ProjectLike>;
};

// -- tokens & shared classes ------------------------------------------------ (Fern & Paper only)

const CARD = "rounded-md border border-line bg-surface px-4 py-3";
const INPUT =
  "rounded-md border border-line-2 bg-bg px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-2";
const CHIP =
  "rounded-full bg-chip px-2 py-px text-[10.5px] font-semibold text-ink-2";

const BLANK: ProfileObj = {
  header: { name: "", contact_line: "" },
  education: { institution: "", degree: "", grad_date: "", gpa: "" },
  skills: { languages: [], tools: [], coursework: [] },
  work_experience: {},
  projects: {},
  community: {},
};

const SKILL_CATS: { key: "languages" | "tools" | "coursework"; label: string }[] = [
  { key: "languages", label: "Languages" },
  { key: "tools", label: "Tools" },
  { key: "coursework", label: "Coursework" },
];

function parseInitial(data: string | null | undefined): ProfileObj | null {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" ? (parsed as ProfileObj) : null;
  } catch {
    return null;
  }
}

function itemName(item: SkillItem): string {
  return typeof item === "string" ? item : item.name;
}

/** Auto-resizing bullet row: grows with its content, no scrollbar. */
function BulletTextarea({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, []);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder="Bullet"
      className={cn(INPUT, "w-full min-h-[30px] resize-none leading-snug")}
      onChange={(e) => onChange(e.target.value)}
      onInput={(e) => {
        const el = e.currentTarget;
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
      }}
    />
  );
}

/** Tag chips with an x to remove and an input to add. */
function TagsEditor({
  tags,
  onAdd,
  onRemove,
}: {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const t = draft.trim();
    if (t && !tags.includes(t)) onAdd(t);
    setDraft("");
  };
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <span key={t} className={cn(CHIP, "group flex items-center gap-1")}>
            {t}
            <button
              type="button"
              onClick={() => onRemove(t)}
              className="text-ink-2 hover:text-red"
              aria-label={`Remove tag ${t}`}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        placeholder="Add tag"
        className={cn(INPUT, "w-full")}
      />
    </div>
  );
}

/** One project card: date, tech, tags, and variant-grouped bullets. */
function ProjectCard({
  name,
  project,
  apply,
}: {
  name: string;
  project: ProjectLike;
  apply: (fn: (p: ProfileObj) => void) => void;
}) {
  const [techText, setTechText] = useState((project.tech ?? []).join(", "));
  const [addingVariant, setAddingVariant] = useState(false);
  const [variantDraft, setVariantDraft] = useState("");

  const setProject = (fn: (proj: ProjectLike) => void) =>
    apply((p) => {
      if (!p.projects) p.projects = {};
      const current = p.projects[name];
      if (!current) return;
      p.projects = { ...p.projects, [name]: { ...current } };
      fn(p.projects[name]);
    });

  const commitVariant = () => {
    const v = variantDraft.trim();
    if (v) {
      setProject((proj) => {
        proj.bullets = { ...proj.bullets, [v]: [""] };
      });
    }
    setVariantDraft("");
    setAddingVariant(false);
  };

  return (
    <div className={CARD}>
      <div className="mb-2">
        <h3 className="text-[13.5px] font-semibold text-ink">{name}</h3>
      </div>

      <label className="mb-2 block">
        <span className="mb-1 block text-[12px] font-medium text-ink-2">Date</span>
        <input
          value={project.date}
          onChange={(e) => setProject((proj) => void (proj.date = e.target.value))}
          placeholder="April - June 2026"
          className={cn(INPUT, "w-full")}
        />
      </label>

      <label className="mb-2 block">
        <span className="mb-1 block text-[12px] font-medium text-ink-2">Tech</span>
        <input
          value={techText}
          onChange={(e) => {
            setTechText(e.target.value);
            const tech = e.target.value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
            setProject((proj) => void (proj.tech = tech));
          }}
          placeholder="React, TypeScript, PostgreSQL"
          className={cn(INPUT, "w-full")}
        />
      </label>

      <div className="mb-2">
        <span className="mb-1 block text-[12px] font-medium text-ink-2">Tags</span>
        <TagsEditor
          tags={project.tags ?? []}
          onAdd={(tag) =>
            setProject((proj) => void (proj.tags = [...(proj.tags ?? []), tag]))
          }
          onRemove={(tag) =>
            setProject(
              (proj) => void (proj.tags = (proj.tags ?? []).filter((t) => t !== tag))
            )
          }
        />
      </div>

      <div>
        <span className="mb-1 block text-[12px] font-medium text-ink-2">Bullets</span>
        {Object.entries(project.bullets).map(([variant, bullets]) => (
          <div key={variant} className="mb-3">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-2">
              {variant}
            </span>
            <div className="space-y-1.5">
              {bullets.map((b, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    <BulletTextarea
                      value={b}
                      onChange={(v) =>
                        apply((p) => {
                          if (!p.projects) return;
                          const current = p.projects[name];
                          if (!current) return;
                          const arr = [...current.bullets[variant]];
                          arr[i] = v;
                          p.projects[name] = {
                            ...current,
                            bullets: { ...current.bullets, [variant]: arr },
                          };
                        })
                      }
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      apply((p) => {
                        if (!p.projects) return;
                        const current = p.projects[name];
                        if (!current) return;
                        p.projects[name] = {
                          ...current,
                          bullets: {
                            ...current.bullets,
                            [variant]: current.bullets[variant].filter(
                              (_, idx) => idx !== i
                            ),
                          },
                        };
                      })
                    }
                    className="mt-1.5 text-ink-2 hover:text-red"
                    aria-label={`Remove bullet ${i + 1}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                setProject((proj) => {
                  proj.bullets = {
                    ...proj.bullets,
                    [variant]: [...proj.bullets[variant], ""],
                  };
                })
              }
              className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-ink-2 hover:text-accent"
            >
              <Plus className="size-3.5" /> Add bullet
            </button>
          </div>
        ))}

        {addingVariant ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={variantDraft}
              onChange={(e) => setVariantDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitVariant();
                }
                if (e.key === "Escape") {
                  setAddingVariant(false);
                  setVariantDraft("");
                }
              }}
              placeholder="Variant name"
              className={cn(INPUT, "flex-1")}
            />
            <Button size="sm" onClick={commitVariant}>
              Add
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAddingVariant(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAddingVariant(true)}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-2 hover:text-accent"
          >
            <Plus className="size-3.5" /> Add variant
          </button>
        )}
      </div>
    </div>
  );
}

export function ProfileEditor({
  initialData,
  user,
}: {
  initialData: string | null;
  user: string;
}) {
  const [profile, setProfile] = useState<ProfileObj | null>(() =>
    parseInitial(initialData)
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [projectDraft, setProjectDraft] = useState("");
  // Per-skill-category draft: the input is driven from the source list until
  // the user edits that line - untouched lines keep their original entries
  // (including {name, keywords} objects) on the round trip.
  const [skills, setSkills] = useState<Record<string, { text: string; dirty: boolean }>>({});

  // Mutate the parsed object in place, then push a fresh top-level reference
  // so React re-renders. Nested objects keep their references, so untouched
  // sections serialize byte-for-byte identically.
  const apply = useCallback((mutate: (p: ProfileObj) => void) => {
    setProfile((p) => {
      if (!p) return p;
      mutate(p);
      setDirty(true);
      return { ...p };
    });
  }, []);

  // Warn on navigating away with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const handleSave = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      const res = await saveProfile(JSON.stringify(profile, null, 2));
      if (res.ok) {
        toast.success("Profile saved");
        setDirty(false);
        setSkills({});
      } else {
        toast.error(res.error);
      }
    } finally {
      setSaving(false);
    }
  };

  const addProject = () => {
    const name = projectDraft.trim();
    if (!name) return;
    if (profile?.projects?.[name]) {
      toast.error("A project with that name already exists.");
      return;
    }
    apply((p) => {
      p.projects = {
        ...(p.projects ?? {}),
        [name]: { date: "", tags: [], tech: [], bullets: { base: [""] } },
      };
    });
    setProjectDraft("");
    setAddingProject(false);
  };

  if (!profile) {
    // No profile on file (or it failed to parse) - explain how one gets one.
    return (
      <div className="space-y-4">
        <div className={CARD}>
          <h2 className="mb-1 text-[13.5px] font-semibold">No profile on file</h2>
          <p className="text-[12px] text-ink-2">
            This account has no resume profile saved yet. The one-time backfill (
            scripts/migrate_profiles_to_convex.py ) seeds it from the repo, or
            you can start from a blank profile and fill it in here.
          </p>
          <Button
            className="mt-3"
            size="sm"
            onClick={() => {
              setProfile({ ...BLANK });
            }}
          >
            <Plus className="size-4" /> Start from a blank profile
          </Button>
        </div>
        <SavedNote user={user} />
      </div>
    );
  }

  const skillsValue = (cat: "languages" | "tools" | "coursework") => {
    if (skills[cat]?.dirty) return skills[cat].text ?? "";
    const list = profile.skills?.[cat] ?? [];
    return list.map(itemName).join(", ");
  };

  const setSkill = (cat: "languages" | "tools" | "coursework", value: string) => {
    setSkills((prev) => ({ ...prev, [cat]: { text: value, dirty: true } }));
    apply((p) => {
      if (!p.skills) p.skills = {};
      const items = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      p.skills[cat] = items;
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* Left: projects - entrance cascade matching the triage list. */}
        <div className="min-w-0 space-y-3">
          {Object.entries(profile.projects ?? {}).map(([name, project], i) => (
            <div
              key={name}
              style={{
                animation: "cascade .5s var(--ease-out-soft) both",
                animationDelay: `${Math.min(i, 8) * 60}ms`,
              }}
            >
              <ProjectCard name={name} project={project} apply={apply} />
            </div>
          ))}

          {addingProject ? (
            <div className={cn(CARD, "flex items-center gap-1.5")}>
              <input
                autoFocus
                value={projectDraft}
                onChange={(e) => setProjectDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addProject();
                  }
                  if (e.key === "Escape") {
                    setAddingProject(false);
                    setProjectDraft("");
                  }
                }}
                placeholder="Project name"
                className={cn(INPUT, "flex-1")}
              />
              <Button size="sm" onClick={addProject}>
                Add
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAddingProject(false);
                  setProjectDraft("");
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setAddingProject(true)}>
              <Plus className="size-4" /> Add project
            </Button>
          )}
        </div>

        {/* Right: header, skills, education */}
        <div className="min-w-0 space-y-3">
          <div className={CARD}>
            <h2 className="mb-2 text-[13.5px] font-semibold">Header</h2>
            <label className="mb-2 block">
              <span className="mb-1 block text-[12px] font-medium text-ink-2">
                Name
              </span>
              <input
                value={profile.header.name}
                onChange={(e) =>
                  apply((p) => void (p.header.name = e.target.value))
                }
                placeholder="First Last"
                className={cn(INPUT, "w-full")}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ink-2">
                Contact line
              </span>
              <input
                value={profile.header.contact_line}
                onChange={(e) =>
                  apply((p) => void (p.header.contact_line = e.target.value))
                }
                placeholder="City | phone | email"
                className={cn(INPUT, "w-full")}
              />
            </label>
          </div>

          <div className={CARD}>
            <h2 className="mb-2 text-[13.5px] font-semibold">Skills</h2>
            {SKILL_CATS.map(({ key, label }) => (
              <label key={key} className="mb-2 block last:mb-0">
                <span className="mb-1 block text-[12px] font-medium text-ink-2">
                  {label}
                </span>
                <input
                  value={skillsValue(key)}
                  onChange={(e) => setSkill(key, e.target.value)}
                  placeholder="Comma-separated"
                  className={cn(INPUT, "w-full")}
                />
              </label>
            ))}
          </div>

          <div className={CARD}>
            <h2 className="mb-2 text-[13.5px] font-semibold">Education</h2>
            <label className="mb-2 block">
              <span className="mb-1 block text-[12px] font-medium text-ink-2">
                Institution
              </span>
              <input
                value={profile.education.institution}
                onChange={(e) =>
                  apply((p) => void (p.education.institution = e.target.value))
                }
                placeholder="School | City, ST"
                className={cn(INPUT, "w-full")}
              />
            </label>
            <label className="mb-2 block">
              <span className="mb-1 block text-[12px] font-medium text-ink-2">
                Degree
              </span>
              <input
                value={profile.education.degree ?? ""}
                onChange={(e) =>
                  apply((p) => {
                    const v = e.target.value;
                    if (v || "degree" in p.education) p.education.degree = v;
                    else delete p.education.degree;
                  })
                }
                placeholder="B.S. Computer Science - GPA 3.7/4.0"
                className={cn(INPUT, "w-full")}
              />
            </label>
            <label className="mb-2 block">
              <span className="mb-1 block text-[12px] font-medium text-ink-2">
                Grad date
              </span>
              <input
                value={profile.education.grad_date}
                onChange={(e) =>
                  apply((p) => void (p.education.grad_date = e.target.value))
                }
                placeholder="Expected Graduation May 2027"
                className={cn(INPUT, "w-full")}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ink-2">
                GPA
              </span>
              <input
                value={profile.education.gpa ?? ""}
                onChange={(e) =>
                  apply((p) => {
                    const v = e.target.value;
                    if (v || "gpa" in p.education) p.education.gpa = v;
                    else delete p.education.gpa;
                  })
                }
                placeholder="3.7"
                className={cn(INPUT, "w-full")}
              />
            </label>
          </div>
        </div>
      </div>

      <SavedNote user={user} />

      {/* Sticky save bar - glass treatment matching the triage dock. */}
      <div className="sticky bottom-0 -mx-5 border-t border-line bg-[color-mix(in_srgb,var(--color-bg)_82%,transparent)] px-5 pb-4 pt-3 backdrop-blur-md">
        <div className="flex items-center justify-end gap-3">
          {dirty && (
            <span
              className="text-[12px] text-ink-2"
              style={{ animation: "toastin .22s var(--ease-out-soft) both" }}
            >
              Unsaved changes
            </span>
          )}
          <Button onClick={handleSave} disabled={!dirty || saving}>
            <Save className="size-4" />
            {saving ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SavedNote({ user }: { user: string }) {
  return (
    <p className="text-[12px] text-ink-2">
      Saved to Convex - the repo users/{user}_resume.json copy is now an export,
      not the source of truth.
    </p>
  );
}
