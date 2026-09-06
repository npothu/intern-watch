import type { ProfileV2 } from "./profile";

// Request ordering and unsaved drafts outlive a mounted editor. The last
// acknowledgement bridges stale route responses while a visit refreshes.
export class ProfileSaveSession {
  tail: Promise<void> = Promise.resolve();
  draft: ProfileV2 | null = null;
  lastSaved: ProfileV2 | null = null;
  revision = 0;
  importing: Promise<unknown> | null = null;

  setDraft(profile: ProfileV2) {
    this.draft = profile;
    this.revision++;
  }

  acknowledge(profile: ProfileV2) {
    this.lastSaved = profile;
    if (this.draft === profile) this.draft = null;
  }

  track(request: Promise<unknown>) {
    this.tail = request.then(
      () => undefined,
      () => undefined,
    );
  }

  beginImport(request: Promise<unknown>) {
    this.importing = request;
    this.revision++;
    this.track(request);
  }

  finishImport(profile?: ProfileV2) {
    this.importing = null;
    if (profile) {
      this.draft = null;
      this.lastSaved = profile;
      this.revision++;
    }
  }
}

const sessions = new Map<string, ProfileSaveSession>();

export function profileSaveSession(user: string): ProfileSaveSession {
  let session = sessions.get(user);
  if (!session) {
    session = new ProfileSaveSession();
    sessions.set(user, session);
  }
  return session;
}
