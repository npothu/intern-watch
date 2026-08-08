"use client";

// Top-level skills editor. This fixes the old editor's bug where every skill
// line was flattened to a comma-joined string on edit, destroying {name,
// keywords} grouping. Here each SkillItem is edited as ITS OWN ROW: a plain
// string stays a string until the user explicitly adds a keyword (which
// converts that one item to { name, keywords } in place); {name, keywords}
// items keep their shape. Editing one row never touches another row's shape.

import { useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProfileV2, SkillItem } from "@/lib/profile";

const CHIP =
  "rounded-full bg-chip px-2 py-0.5 text-[10.5px] font-semibold text-ink-2";
const INPUT =
  "w-full min-w-0 rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-2";

const GROUPS: { key: "languages" | "tools" | "coursework"; label: string }[] = [
  { key: "languages", label: "Languages" },
  { key: "tools", label: "Systems & Tools" },
  { key: "coursework", label: "Coursework" },
];

/** Chip list with an x to remove and an input to add (Enter commits). */
function KeywordEditor({
  keywords,
  onAdd,
  onRemove,
}: {
  keywords: string[];
  onAdd: (k: string) => void;
  onRemove: (k: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const k = draft.trim();
    if (k && !keywords.includes(k)) onAdd(k);
    setDraft("");
  };
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {keywords.map((k) => (
          <span key={k} className={cn(CHIP, "flex items-center gap-1")}>
            {k}
            <button
              type="button"
              onClick={() => onRemove(k)}
              className="text-ink-2 hover:text-red"
              aria-label={`Remove keyword ${k}`}
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
        placeholder="Add keyword"
        className={cn(INPUT, "max-w-[220px]")}
      />
    </div>
  );
}

export function SkillsEditor(props: {
  skills: ProfileV2["skills"];
  onChange: (skills: ProfileV2["skills"]) => void;
}) {
  const groupItems = useMemo(
    () => ({
      languages: props.skills.languages ?? [],
      tools: props.skills.tools ?? [],
      coursework: props.skills.coursework ?? [],
      certifications: props.skills.certifications ?? [],
    }),
    [props.skills]
  );

  // Update one group's array, never mutating props.skills in place.
  const updateGroup = (
    key: "languages" | "tools" | "coursework",
    next: SkillItem[]
  ) => {
    props.onChange({ ...props.skills, [key]: next });
  };

  const updateCerts = (next: string[]) => {
    props.onChange({ ...props.skills, certifications: next });
  };

  return (
    <div className="space-y-4">
      {GROUPS.map(({ key, label }) => {
        const items = groupItems[key];
        return (
          <div key={key}>
            <h4 className="mb-2 text-[12.5px] font-semibold text-ink">{label}</h4>
            <div className="space-y-2">
              {items.map((item, i) => (
                <SkillRow
                  key={i}
                  item={item}
                  onChangeItem={(next) => {
                    // Replace only index i - other rows keep their exact shape
                    // and content untouched.
                    const nextArr = items.map((it, idx) =>
                      idx === i ? next : it
                    );
                    updateGroup(key, nextArr);
                  }}
                  onRemove={() => {
                    updateGroup(
                      key,
                      items.filter((_, idx) => idx !== i)
                    );
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => updateGroup(key, [...items, ""])}
              className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-ink-2 hover:text-accent"
            >
              <Plus className="size-3.5" />
              Add
            </button>
          </div>
        );
      })}

      {/* Certifications - plain strings only, no chips. */}
      <div>
        <h4 className="mb-2 text-[12.5px] font-semibold text-ink">
          Certifications
        </h4>
        <div className="space-y-2">
          {groupItems.certifications.map((c, i) => (
            <div key={i} className="flex items-center gap-1.5 min-w-0">
              <input
                value={c}
                onChange={(e) =>
                  updateCerts(
                    groupItems.certifications.map((it, idx) =>
                      idx === i ? e.target.value : it
                    )
                  )
                }
                placeholder="Certification"
                className={cn(INPUT, "flex-1 min-w-0")}
              />
              <button
                type="button"
                onClick={() =>
                  updateCerts(
                    groupItems.certifications.filter((_, idx) => idx !== i)
                  )
                }
                aria-label="Remove certification"
                className="shrink-0 rounded p-0.5 text-ink-2 hover:text-red"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => updateCerts([...groupItems.certifications, ""])}
          className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-ink-2 hover:text-accent"
        >
          <Plus className="size-3.5" />
          Add
        </button>
      </div>
    </div>
  );
}

function SkillRow({
  item,
  onChangeItem,
  onRemove,
}: {
  item: SkillItem;
  onChangeItem: (next: SkillItem) => void;
  onRemove: () => void;
}) {
  const [addingKeyword, setAddingKeyword] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isObject = typeof item === "object";
  const objItem = isObject ? item : undefined;
  const name = isObject ? item.name : item;
  const keywords = objItem?.keywords ?? [];

  // Plain-string -> {name, keywords} conversion happens HERE, in place, so the
  // keyword UI can open immediately without ever flattening back to a string.
  const ensureObject = (): { name: string; keywords?: string[] } => {
    if (objItem) return objItem;
    const obj = { name: item as string, keywords: [] as string[] };
    onChangeItem(obj);
    return obj;
  };

  const addKeyword = (k: string) => {
    const obj = ensureObject();
    onChangeItem({ ...obj, keywords: [...(obj.keywords ?? []), k] });
  };

  const removeKeyword = (k: string) => {
    if (!objItem) return;
    onChangeItem({ ...objItem, keywords: keywords.filter((x) => x !== k) });
  };

  const openKeywordUi = () => {
    ensureObject();
    setAddingKeyword(true);
    // Focus after React renders the input.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const showKeywordUi = objItem !== undefined || addingKeyword;

  return (
    <div className="min-w-0 rounded-md border border-line bg-bg px-2.5 py-2">
      <div className="flex items-center gap-1.5 min-w-0">
        <input
          value={name}
          onChange={(e) =>
            onChangeItem(
              objItem ? { ...objItem, name: e.target.value } : e.target.value
            )
          }
          placeholder="Skill"
          className={cn(INPUT, "flex-1 min-w-0")}
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove skill"
          className="shrink-0 rounded p-0.5 text-ink-2 hover:text-red"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {showKeywordUi && (
        <div className="mt-2">
          <KeywordEditor
            keywords={keywords}
            onAdd={(k) => {
              addKeyword(k);
              setAddingKeyword(false);
            }}
            onRemove={removeKeyword}
          />
        </div>
      )}

      {!objItem && !addingKeyword && (
        <button
          type="button"
          onClick={openKeywordUi}
          className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-2 hover:text-accent"
        >
          <Plus className="size-3" />
          keyword
        </button>
      )}
    </div>
  );
}

