// Per-user, non-secret preferences: which model tailors their resume, and the
// daily allowance they have already spent on the operator's key.
//
// Split from credentials.ts on purpose - nothing here is a secret, so these are
// ordinary queries/mutations the web app can read directly, with none of the
// encryption ceremony. The secret half (an optional API key for the chosen
// provider) stays in `credentials`.

import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { isProvider, OPERATOR_MODEL, OPERATOR_PROVIDER } from "./llm_providers";

/**
 * Operator-key resume builds allowed per user per day.
 *
 * This is the guard that replaced the old "deliberately NO fallback" rule in
 * credentials.ts. The concern there was real - one user should not be able to
 * spend the host's whole quota - but refusing to run at all was a blunt fix
 * that pushed setup work onto every user. A cap keeps the protection and drops
 * the friction: bring your own key and this number stops applying to you.
 *
 * Mirrors convex/mail.ts's LLM_DAILY_CAP, which solves the same problem for
 * the mail classifier.
 */
export const OPERATOR_DAILY_CAP = 25;

/** UTC calendar day, the bucket the counter resets on. */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function assertSecret(secret: string) {
  if (secret !== process.env.TRACKER_SECRET) {
    throw new Error("bad secret");
  }
}

// -- reads --------------------------------------------------------------------

/**
 * The user's resume-model preference plus today's operator-key usage, for the
 * Settings page. Never returns a key or any part of one.
 */
export const getResumeLlm = query({
  args: { user: v.string(), secret: v.string() },
  handler: async (ctx, { user, secret }) => {
    assertSecret(secret);
    const row = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first();
    const today = dayKey(Date.now());
    const used = row?.llmDay === today ? (row.llmCount ?? 0) : 0;
    return {
      // null provider means "use whatever the operator provides".
      provider: isProvider(row?.resumeProvider) ? row!.resumeProvider! : null,
      model: row?.resumeModel ?? null,
      defaultProvider: OPERATOR_PROVIDER,
      defaultModel: OPERATOR_MODEL,
      dailyCap: OPERATOR_DAILY_CAP,
      usedToday: used,
      // Whether a shared model exists at all on this deployment. Without it
      // the UI would advertise "25 of 25 builds left" against a quota that can
      // never be spent, and every build would come back as bank text with no
      // hint from Settings that the shared model is simply absent.
      sharedAvailable: Boolean(process.env.GEMINI_API_KEY),
    };
  },
});

/** Read-only view of today's allowance, so a build can check before spending.
 *  Kept separate from consumeOperatorLlm: charging happens only after a model
 *  call has actually produced text. */
export const operatorCapReached = internalQuery({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
    const row = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first();
    const today = dayKey(Date.now());
    const used = row?.llmDay === today ? (row.llmCount ?? 0) : 0;
    return used >= OPERATOR_DAILY_CAP;
  },
});

export const getSettingsInternal = internalQuery({
  args: { user: v.string() },
  handler: async (ctx, { user }) =>
    ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first(),
});

// -- writes -------------------------------------------------------------------

/**
 * Save (or clear) the resume-model preference. Passing a null/empty provider
 * resets the user to the operator default, which is also what a brand-new user
 * has - there is deliberately no separate "reset" mutation.
 */
export const setResumeLlm = mutation({
  args: {
    user: v.string(),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    secret: v.string(),
  },
  handler: async (ctx, { user, provider, model, secret }) => {
    assertSecret(secret);
    if (provider && !isProvider(provider)) {
      throw new Error(`unknown provider: ${provider}`);
    }
    const patch = {
      resumeProvider: provider || undefined,
      // A model without a provider is meaningless; drop it rather than storing
      // an orphan that would silently do nothing.
      resumeModel: provider ? model?.trim() || undefined : undefined,
      updatedAt: Date.now(),
    };
    const row = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first();
    if (row) {
      await ctx.db.patch(row._id, patch);
    } else {
      await ctx.db.insert("settings", { user, ...patch });
    }
    return { ok: true as const };
  },
});

/**
 * Consume one unit of the user's daily operator-key allowance.
 *
 * Returns false when the cap is already spent, in which case the caller runs
 * the build WITHOUT the LLM rather than failing - a capped user still gets a
 * resume, just with bank text, and the report says why.
 *
 * Counted only for the operator's key. Internal: a client must not be able to
 * move this number.
 */
export const consumeOperatorLlm = internalMutation({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
    const today = dayKey(Date.now());
    const row = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first();
    const used = row?.llmDay === today ? (row.llmCount ?? 0) : 0;
    if (used >= OPERATOR_DAILY_CAP) return { allowed: false as const, used };
    if (row) {
      await ctx.db.patch(row._id, { llmDay: today, llmCount: used + 1, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("settings", {
        user,
        llmDay: today,
        llmCount: 1,
        updatedAt: Date.now(),
      });
    }
    return { allowed: true as const, used: used + 1 };
  },
});
