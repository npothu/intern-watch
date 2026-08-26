"""Notification channels: Discord webhook (instant) and email digest (batched).

Both group matches by term. Email items are display-ready snapshots taken at
accept time (see state outbox), so they survive a job rotating out of the
sources before the send slot arrives.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import html as html_mod
import logging
import smtplib
import time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path

import httpx

from .models import Job
from .normalize import extract_jobright_id

log = logging.getLogger(__name__)

CHUNK_LIMIT = 1900  # Discord hard limit is 2000; leave margin

_UNKNOWN = "Unknown term"


def primary_term(job: Job, terms_order: list[str]) -> str:
    for t in terms_order:
        if t in job.terms:
            return t
    return job.terms[0] if job.terms else _UNKNOWN


def _tag(reasons: list[str]) -> str:
    if "company:priority" in reasons:
        return "[PRIORITY] "
    for r in reasons:
        if r.startswith("company:top"):
            return "[TOP*] " if "LLM" in r else "[TOP] "
        if r.startswith("company:atlanta") or r.startswith("location:atlanta") \
                or r == "location:atlanta-metro":
            return "[ATL*] " if "LLM" in r else "[ATL] "
        if r == "location:remote":
            return "[REMOTE] "
        if r.startswith("location:"):
            return "[ATL] "
    return ""


def _rank_tag(tag: str) -> int:
    """Delivery order within a term group: priority, then top, then the rest.
    Alphabetical by company after that (see the sort keys below)."""
    if tag.startswith("[PRIORITY]"):
        return 0
    if tag.startswith("[TOP"):
        return 1
    return 2


def _line(job: Job, reasons: list[str]) -> str:
    loc = job.locations[0] if job.locations else (job.work_model or "?")
    if len(job.locations) > 1:
        loc += f" +{len(job.locations) - 1}"
    salary = f" [{job.salary}]" if job.salary else ""
    return f"• {_tag(reasons)}{job.company} — {job.title} ({loc}){salary} → <{job.url}>"


def build_digest(matches: list[tuple[Job, list[str]]], terms_order: list[str],
                 now: dt.datetime) -> list[str]:
    """Render matches into Discord-sized chunks. Empty matches -> []."""
    if not matches:
        return []

    groups: dict[str, list[tuple[Job, list[str]]]] = {}
    for job, reasons in matches:
        groups.setdefault(primary_term(job, terms_order), []).append((job, reasons))

    order = [t for t in terms_order if t in groups] \
        + sorted(t for t in groups if t not in terms_order and t != _UNKNOWN) \
        + ([_UNKNOWN] if _UNKNOWN in groups else [])

    lines = [f"🆕 **intern-watch — {len(matches)} new "
             f"match{'es' if len(matches) != 1 else ''}** "
             f"({now.strftime('%b %d, %I:%M %p UTC').lstrip('0')})"]
    for term in order:
        lines.append(f"── **{term}** ──")
        ordered = sorted(groups[term],
                         key=lambda m: (_rank_tag(_tag(m[1])),
                                        m[0].company.casefold()))
        for job, reasons in ordered:
            lines.append(_line(job, reasons))

    chunks: list[str] = []
    current = ""
    for line in lines:
        line = line[:CHUNK_LIMIT]  # a single pathological line must not wedge the digest
        if current and len(current) + len(line) + 1 > CHUNK_LIMIT:
            chunks.append(current)
            current = line
        else:
            current = f"{current}\n{line}" if current else line
    if current:
        chunks.append(current)
    return chunks


# ------------------------------------------------------------------ email

def outbox_item(job: Job, reasons: list[str], terms_order: list[str]) -> dict:
    """Display-ready snapshot of an accepted match for the email outbox."""
    loc = job.locations[0] if job.locations else (job.work_model or "?")
    if len(job.locations) > 1:
        loc += f" +{len(job.locations) - 1}"
    item: dict = {
        "key": job.dedup_key, "company": job.company, "title": job.title,
        "location": loc, "salary": job.salary, "url": job.url,
        "tag": _tag(reasons).strip(), "term": primary_term(job, terms_order)}
    if "company:priority" in reasons:
        # Only ever True; absent otherwise so older snapshots read the same.
        item["priority"] = True
    return item


def match_item(job: Job, reasons: list[str], terms_order: list[str]) -> dict:
    """`outbox_item` plus optional resume-build / on-demand-rebuild fields.

    `resume` (relative POSIX .docx path) is filled in by the caller after a
    successful auto-build; `jobright_id`/`jd_url` let an on-demand rebuild
    reacquire the JD long after the source row rotated out; `jobright_url`
    points back at the jobright info page once the url is an employer link.
    All are optional and ignored by existing readers (email/dashboard) when
    absent."""
    item = outbox_item(job, reasons, terms_order)
    if job.jobright_id:
        item["jobright_id"] = job.jobright_id
        if extract_jobright_id(job.url) is None:
            item["jobright_url"] = f"https://jobright.ai/jobs/info/{job.jobright_id}"
    if job.jd_url:
        item["jd_url"] = job.jd_url
    return item


def _group_items(items: list[dict], terms_order: list[str]) -> list[tuple[str, list[dict]]]:
    groups: dict[str, list[dict]] = {}
    for item in items:
        groups.setdefault(item.get("term") or _UNKNOWN, []).append(item)
    order = [t for t in terms_order if t in groups] \
        + sorted(t for t in groups if t not in terms_order and t != _UNKNOWN) \
        + ([_UNKNOWN] if _UNKNOWN in groups else [])
    return [(t, sorted(groups[t], key=lambda i: (_rank_tag(i.get("tag") or ""),
                                                 i["company"].casefold())))
            for t in order]


def priority_names(items: list[dict], limit: int = 3) -> str:
    """'Microsoft, Meta' / 'Microsoft, Meta, Amazon +2' -- the priority
    companies among `items`, first-seen order, for a subject line. Empty when
    none are priority."""
    seen: list[str] = []
    for it in items:
        if it.get("priority") and it["company"] not in seen:
            seen.append(it["company"])
    if not seen:
        return ""
    head = ", ".join(seen[:limit])
    extra = len(seen) - limit
    return f"{head} +{extra}" if extra > 0 else head


_EMAIL_STYLE = ("font-family:Arial,Helvetica,sans-serif;"
                "font-size:14px;line-height:1.5")


def _item_lines(it: dict) -> tuple[str, str]:
    """(html <li>, text bullet) for one outbox item."""
    esc = html_mod.escape
    tag_html = f"<b>{esc(it['tag'])}</b> " if it.get("tag") else ""
    salary_html = f" <i>[{esc(it['salary'])}]</i>" if it.get("salary") else ""
    html = (f"<li>{tag_html}{esc(it['company'])} &mdash; "
            f"<a href=\"{esc(it['url'])}\">{esc(it['title'])}</a> "
            f"({esc(it['location'])}){salary_html}</li>")
    tag_txt = f"{it['tag']} " if it.get("tag") else ""
    salary_txt = f" [{it['salary']}]" if it.get("salary") else ""
    text = (f"• {tag_txt}{it['company']} — {it['title']} "
            f"({it['location']}){salary_txt}\n  {it['url']}")
    return html, text


def build_email(items: list[dict], terms_order: list[str],
                now: dt.datetime,
                health_warnings: list[str] | None = None,
                subject_names: bool = True) -> tuple[str, str, str]:
    """Returns (subject, html_body, text_body) for the accumulated outbox.
    With `subject_names`, priority companies in the batch are named in the
    subject so the alert reads from the inbox list."""
    grouped = _group_items(items, terms_order)
    counts = ", ".join(f"{t}: {len(g)}" for t, g in grouped)
    names = priority_names(items) if subject_names else ""
    subject = (f"intern-watch: {len(items)} new · {names} ({counts})" if names
               else f"intern-watch: {len(items)} new ({counts})")

    esc = html_mod.escape
    html_parts = [
        f"<html><body style=\"{_EMAIL_STYLE}\">",
        f"<p><b>{len(items)} new internship match"
        f"{'es' if len(items) != 1 else ''}</b> &mdash; "
        f"{esc(now.strftime('%b %d, %I:%M %p UTC').lstrip('0'))}</p>",
    ]
    text_parts = [f"{len(items)} new internship matches — "
                  f"{now.strftime('%b %d, %I:%M %p UTC').lstrip('0')}"]
    for term, group in grouped:
        html_parts.append(f"<h3 style=\"margin:14px 0 4px\">{esc(term)}</h3><ul "
                          "style=\"margin:0;padding-left:20px\">")
        text_parts.append(f"\n== {term} ==")
        for it in group:
            html, text = _item_lines(it)
            html_parts.append(html)
            text_parts.append(text)
        html_parts.append("</ul>")
    if health_warnings:
        esc_w = [esc(w) for w in health_warnings]
        html_parts.append(
            "<hr><p style=\"color:#a33\"><b>⚠ Source health</b><br>"
            + "<br>".join(esc_w)
            + "<br><i>Check the Actions logs; the rest of the pipeline is "
            "unaffected.</i></p>")
        text_parts.append("\n== Source health ==")
        text_parts.extend(f"⚠ {w}" for w in health_warnings)
    html_parts.append("</body></html>")
    return subject, "".join(html_parts), "\n".join(text_parts)


def build_priority_email(items: list[dict], terms_order: list[str],
                         now: dt.datetime) -> tuple[str, str, str]:
    """A priority alert: sent on the run that found the match instead of at
    the next digest slot. One match puts the company and title in the
    subject; several name the companies. Ordered like the digest."""
    ordered = [it for _t, g in _group_items(items, terms_order) for it in g]
    n = len(ordered)
    if n == 1:
        it = ordered[0]
        subject = f"intern-watch: {it['company']} - {it['title']} ({it['term']})"
    else:
        subject = f"intern-watch: {n} priority matches · {priority_names(ordered)}"
    esc = html_mod.escape
    stamp = now.strftime('%b %d, %I:%M %p UTC').lstrip('0')
    html_parts = [
        f"<html><body style=\"{_EMAIL_STYLE}\">",
        f"<p><b>Priority match{'es' if n != 1 else ''}</b> &mdash; {esc(stamp)}</p>",
        "<ul style=\"margin:0;padding-left:20px\">",
    ]
    text_parts = [f"Priority match{'es' if n != 1 else ''} — {stamp}", ""]
    for it in ordered:
        html, text = _item_lines(it)
        html_parts.append(html)
        text_parts.append(text)
    html_parts.append(
        "</ul><p style=\"color:#666\"><i>Sent right away; the daily digest "
        "will not repeat these.</i></p></body></html>")
    text_parts.append("\nSent right away; the daily digest will not repeat these.")
    return subject, "".join(html_parts), "\n".join(text_parts)


def build_health_email(health_warnings: list[str],
                       now: dt.datetime) -> tuple[str, str, str]:
    """Standalone alert for when a send slot passes with no matches but a
    source has been broken long enough to need eyes on it."""
    esc = html_mod.escape
    n = len(health_warnings)
    subject = f"intern-watch: {n} source{'s' if n != 1 else ''} failing"
    html_body = (
        "<html><body style=\"font-family:Arial,Helvetica,sans-serif;"
        "font-size:14px;line-height:1.5\">"
        f"<p><b>⚠ Source health warning</b> &mdash; "
        f"{esc(now.strftime('%b %d, %I:%M %p UTC').lstrip('0'))}</p><ul>"
        + "".join(f"<li>{esc(w)}</li>" for w in health_warnings)
        + "</ul><p><i>No new matches this slot. Check the Actions logs; "
        "other sources keep running normally.</i></p></body></html>")
    text_body = "\n".join(
        [f"Source health warning — "
         f"{now.strftime('%b %d, %I:%M %p UTC').lstrip('0')}", ""]
        + [f"⚠ {w}" for w in health_warnings]
        + ["", "No new matches this slot. Check the Actions logs; "
           "other sources keep running normally."])
    return subject, html_body, text_body


# .docx MIME type; split so add_attachment gets (maintype, subtype).
_DOCX_MIME = ("application/vnd.openxmlformats-officedocument."
              "wordprocessingml.document")


def _sender_domain(smtp_user: str) -> str:
    """Domain half of the sender address, for Message-ID. Falls back to a
    fixed label so a malformed sender never raises out of a pure builder."""
    _, _, dom = smtp_user.rpartition("@")
    return dom or "intern-watch"


def _thread_token(user: str | None, smtp_user: str) -> str:
    """A STABLE Message-ID-shaped token so every digest to one user threads
    together in Gmail. Deterministic in (user, sender) -- NOT random -- so the
    same user always reuses one References anchor, but different users (or a
    different sender) get distinct threads."""
    digest = hashlib.sha256(f"{user or ''}\0{smtp_user}".encode()).hexdigest()
    return f"<intern-watch-thread-{digest[:32]}@{_sender_domain(smtp_user)}>"


def build_message(smtp_user: str, to_addr: str, subject: str,
                  html_body: str, text_body: str,
                  attachments: list[Path] | None = None,
                  user: str | None = None) -> EmailMessage:
    """Assemble the EmailMessage (split out so tests can assert on parts
    without sending -- kept PURE, no I/O). Each existing attachment is added as
    a .docx; missing files are skipped silently so a stale outbox path never
    blocks the send.

    Standards headers improve deliverability and let Gmail collapse a user's
    digests into one thread: a stable per-(user, sender) References/In-Reply-To
    token anchors the thread, while Date/Message-ID/Reply-To and a one-click
    List-Unsubscribe round out the headers spam filters look for."""
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = smtp_user
    msg["To"] = to_addr
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=_sender_domain(smtp_user))
    msg["Reply-To"] = smtp_user
    thread = _thread_token(user, smtp_user)
    msg["References"] = thread
    msg["In-Reply-To"] = thread
    msg["List-Unsubscribe"] = f"<mailto:{smtp_user}?subject=unsubscribe>"
    msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")
    maintype, subtype = _DOCX_MIME.split("/", 1)
    for path in attachments or []:
        try:
            if not path.exists():
                continue
            data = path.read_bytes()
        except OSError:  # noqa: BLE001 -- a bad path must not lose the email
            continue
        msg.add_attachment(data, maintype=maintype, subtype=subtype,
                           filename=path.name)
    return msg


def send_email(smtp_user: str, smtp_password: str, to_addr: str,
               subject: str, html_body: str, text_body: str,
               attachments: list[Path] | None = None,
               user: str | None = None) -> bool:
    """Send via Gmail SMTP (SSL). True only on clean send -- the caller keeps
    the outbox and retries next run on False. `user` threads each user's
    digests together in Gmail (see build_message)."""
    msg = build_message(smtp_user, to_addr, subject, html_body, text_body,
                        attachments, user=user)
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as server:
            server.login(smtp_user, smtp_password)
            server.send_message(msg)
        return True
    except (smtplib.SMTPException, OSError) as exc:
        log.error("email send failed: %s", exc)
        return False


def send_discord(webhook_url: str, chunks: list[str]) -> bool:
    """POST every chunk; True only if ALL got a 2xx. Caller marks
    notified_for only on True."""
    with httpx.Client(timeout=15.0) as client:
        for i, chunk in enumerate(chunks):
            try:
                resp = client.post(webhook_url, json={"content": chunk})
                if resp.status_code // 100 != 2:
                    log.error("discord webhook returned %d: %s",
                              resp.status_code, resp.text[:300])
                    return False
            except httpx.HTTPError as exc:
                log.error("discord webhook error: %s", exc)
                return False
            if i < len(chunks) - 1:
                time.sleep(0.6)  # webhook rate limit headroom
    return True
