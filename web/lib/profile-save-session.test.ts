import { describe, expect, it } from "vitest";
import { blankProfile } from "./profile";
import { ProfileSaveSession, profileSaveSession } from "./profile-save-session";

describe("resume saves across navigation", () => {
  it("shares unsaved work on re-entry without crossing users", () => {
    const firstMount = profileSaveSession("navigation-test");
    const draft = blankProfile();
    firstMount.setDraft(draft);
    expect(profileSaveSession("navigation-test").draft).toBe(draft);
    expect(profileSaveSession("another-user").draft).toBeNull();
  });

  it("keeps a newer draft when an older save finishes", () => {
    const session = new ProfileSaveSession();
    const first = blankProfile();
    const latest = blankProfile();
    session.setDraft(first);
    const revision = session.revision;
    session.setDraft(latest);
    session.acknowledge(first);
    expect(session.draft).toBe(latest);
    expect(session.revision).toBeGreaterThan(revision);
    session.acknowledge(latest);
    expect(session.draft).toBeNull();
    // A stale route response must not replace the last successful local save.
    expect(session.lastSaved).toBe(latest);
  });

  it("orders returning-editor writes after the outgoing save, including failures", async () => {
    const session = new ProfileSaveSession();
    let finish!: () => void;
    const order: string[] = [];
    const outgoing = new Promise<void>((resolve) => {
      finish = resolve;
    }).then(() => {
      order.push("outgoing");
      throw new Error("network failure");
    });
    session.track(outgoing);
    const returning = session.tail.then(() => {
      order.push("returning");
    });
    session.track(returning);
    expect(order).toEqual([]);
    finish();
    await session.tail;
    expect(order).toEqual(["outgoing", "returning"]);
  });

  it("retains failed import drafts and replaces them only on successful import", () => {
    const session = new ProfileSaveSession();
    const before = blankProfile();
    const imported = blankProfile();
    session.setDraft(before);
    session.beginImport(Promise.resolve());
    session.finishImport();
    expect(session.draft).toBe(before);
    session.beginImport(Promise.resolve());
    session.finishImport(imported);
    expect(session.importing).toBeNull();
    expect(session.draft).toBeNull();
    expect(session.lastSaved).toBe(imported);
  });
});
