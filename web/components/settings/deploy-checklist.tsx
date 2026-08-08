import Link from "next/link";

// Deployment env presence for the Connections page. This surface only ever
// reports whether a value is SET, never what it is.
//
// Reads are written out statically as `process.env.NAME` rather than looked up
// through a `process.env[name]` index. Next inlines the static form at build
// time; the dynamic form only happens to work here because this is a server
// component reading the real Node object, and it would silently report every
// row as missing the moment that stopped being true. Static reads cannot fail
// that way, and they make the set of names this file touches greppable.
type Item = { env: string; desc: string; set: boolean };

function bootItems(): Item[] {
  return [
    {
      env: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      desc: "Sign-in",
      set: Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY),
    },
    { env: "CLERK_SECRET_KEY", desc: "Sign-in", set: Boolean(process.env.CLERK_SECRET_KEY) },
    {
      env: "TRACKER_USER_MAP",
      desc: "Maps signed-in emails to tracker users",
      set: Boolean(process.env.TRACKER_USER_MAP),
    },
    { env: "CONVEX_URL", desc: "Convex data endpoint", set: Boolean(process.env.CONVEX_URL) },
    {
      env: "CONVEX_SECRET",
      desc: "Every mutation checks it",
      set: Boolean(process.env.CONVEX_SECRET),
    },
    {
      env: "CREDENTIALS_KEY",
      desc: "Encrypts stored connection secrets",
      set: Boolean(process.env.CREDENTIALS_KEY),
    },
  ];
}

// These four are no longer terminal-only: the Google setup writes them straight
// to the deployment through the Convex management API, so the row points at the
// wizard rather than telling you to go run a command.
function googleItems(): Item[] {
  return [
    {
      env: "GMAIL_CLIENT_ID",
      desc: "OAuth client",
      set: Boolean(process.env.GMAIL_CLIENT_ID),
    },
    {
      env: "GMAIL_CLIENT_SECRET",
      desc: "OAuth client",
      set: Boolean(process.env.GMAIL_CLIENT_SECRET),
    },
    {
      env: "MAIL_PUBSUB_TOPIC",
      desc: "Gmail push topic",
      set: Boolean(process.env.MAIL_PUBSUB_TOPIC),
    },
    {
      env: "MAIL_PUSH_TOKEN",
      desc: "Gmail push is unguarded without it",
      set: Boolean(process.env.MAIL_PUSH_TOKEN),
    },
  ];
}

function Rows({ items }: { items: Item[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      {items.map((item) => (
        <div
          key={item.env}
          className="flex items-center gap-2.5 border-b border-line px-3 py-2 text-[12px] last:border-b-0"
        >
          <span aria-hidden className="w-3 flex-none text-center font-bold">
            {item.set ? (
              <span className="text-accent">&#10003;</span>
            ) : (
              <span className="text-red">&#10007;</span>
            )}
          </span>
          <span className="sr-only">{item.set ? "Set" : "Not set"}</span>
          <span className="min-w-0 flex-none break-words font-mono text-[11px]">{item.env}</span>
          <span className="min-w-0 flex-1 break-words text-ink-2">{item.desc}</span>
        </div>
      ))}
    </div>
  );
}

function Heading({ title, tag }: { title: string; tag: string }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2">{title}</h2>
      <span className="rounded-full bg-chip px-2 py-0.5 font-mono text-[10.5px] text-ink-2">
        {tag}
      </span>
    </div>
  );
}

export function DeployChecklist() {
  return (
    <div className="space-y-6">
      <div>
        <Heading title="Set at deploy time" tag="read-only" />
        <Rows items={bootItems()} />
        <p className="mt-2 text-[11px] text-ink-2">
          These are read at boot, so editing them here could not take effect. Set with{" "}
          <code className="font-mono">npx convex env set</code> or in the Vercel project, then
          redeploy.
        </p>
      </div>

      <div>
        <Heading title="Google setup" tag="managed here" />
        <Rows items={googleItems()} />
        <p className="mt-2 text-[11px] text-ink-2">
          The{" "}
          <Link href="/settings/connections/google" className="text-accent underline">
            Google setup
          </Link>{" "}
          writes these to the deployment for you. Functions pick a new value up on their next run.
        </p>
      </div>
    </div>
  );
}
