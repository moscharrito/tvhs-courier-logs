#!/usr/bin/env python3
"""Give every driver a fresh password and write them into one Word document.

WHY THIS IS A SCRIPT AND NOT A FEW CURL CALLS.

Thirty-five passwords have to be generated, set, and written down exactly
once, and the written-down copy has to be the only copy. Anything done by
hand puts them in a shell history, a terminal scrollback, or a chat
transcript, and a password that has been in three places is not a password
any more.

So this generates, sets and writes in one pass, and prints NOTHING but the
username and whether it worked. The passwords exist in memory and in the
.docx and nowhere else.

WHAT IT PRODUCES, AND HOW TO TREAT IT.

One Word file: name, username, password, one row per driver. It is a list of
live credentials for accounts that reach patient data. Hand each driver their
own line, tell them to change it, and delete the file once they have. Do not
email it whole. `*.docx` is gitignored, which keeps it out of the repository
and is not the same as keeping it safe.

THE SHAPE OF THE PASSWORD IS CHOSEN FOR A PHONE AT A COUNTER.

Twelve characters from an alphabet with no 0/o, 1/l/i or 5/s in it, in three
groups of four. About fifty-nine bits, which is far beyond guessing, and it
can still be read off a sheet of paper and typed on a phone keyboard by
somebody standing up. Lower case only: a capital that nobody can see on
paper is a support call.

    python3 server/scripts/driver-passwords.py --file drivers.csv
        Who would be reset. Changes nothing, writes nothing.

    ... --base https://logs.izyglobalservices.com --i-mean-production --apply
        Sets them and writes the document.

The admin password comes from SEED_ADMIN_PASS and is never printed.
"""

import argparse
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
from datetime import date

# No 0/O, 1/l/I, 5/S, 2/Z: every one of those is a support call when somebody
# reads it off paper. 31 characters, so 12 of them is about 59 bits.
ALPHABET = "abcdefghjkmnpqrtuvwxy34679"


def make_password() -> str:
    """Three groups of four. The hyphens are for reading, not for entropy."""
    raw = "".join(secrets.choice(ALPHABET) for _ in range(12))
    return f"{raw[0:4]}-{raw[4:8]}-{raw[8:12]}"


def read_drivers(path):
    """`username,name,email` per line; # starts a comment."""
    out = []
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.split("#")[0].strip()
            if not line:
                continue
            parts = [c.strip() for c in line.split(",")]
            if len(parts) < 2:
                print(f"  line {n}: expected username,name[,email] — skipped")
                continue
            out.append({"username": parts[0], "name": parts[1],
                        "email": parts[2] if len(parts) > 2 else ""})
    return out


class Api:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.cookie = ""

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.cookie:
            req.add_header("Cookie", self.cookie)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                for key, value in res.getheaders():
                    if key.lower() == "set-cookie":
                        self.cookie = value.split(";")[0]
                return res.status, res.read().decode()
        except urllib.error.HTTPError as err:
            return err.code, err.read().decode()


def write_docx(rows, out_path, base):
    from docx import Document
    from docx.shared import Pt

    doc = Document()
    doc.add_heading("UH Pharmacy Courier — driver sign-in details", level=0)

    doc.add_paragraph(
        f"Generated {date.today().isoformat()} for {base}. "
        f"{len(rows)} drivers."
    )

    warn = doc.add_paragraph()
    run = warn.add_run(
        "These are live passwords for accounts that reach patient information. "
        "Give each driver their own line and nobody else's. Ask them to change it "
        "once they are in — Your account, Change password. Delete this file when "
        "everyone has signed in."
    )
    run.bold = True

    doc.add_heading("How a driver signs in", level=1)
    doc.add_paragraph(
        "1. Open logs.izyglobalservices.com/uh on the phone — the /uh matters, "
        "it goes straight to this contract.", style="List Number")
    doc.add_paragraph(
        "2. Username is the first name below, not an email address.", style="List Number")
    doc.add_paragraph(
        "3. Type the password exactly, hyphens included. It is all lower case.",
        style="List Number")
    doc.add_paragraph(
        "4. Change it: Your account, then Change password.", style="List Number")

    doc.add_heading("Drivers", level=1)
    table = doc.add_table(rows=1, cols=3)
    table.style = "Table Grid"
    head = table.rows[0].cells
    for i, label in enumerate(("Name", "Username", "Password")):
        head[i].text = label
        for p in head[i].paragraphs:
            for r in p.runs:
                r.bold = True

    for row in rows:
        cells = table.add_row().cells
        cells[0].text = row["name"]
        cells[1].text = row["username"]
        cells[2].text = row["password"]
        # Monospaced, so a hyphen is a hyphen and an l is not a 1.
        for p in cells[2].paragraphs:
            for r in p.runs:
                r.font.name = "Consolas"
                r.font.size = Pt(11)

    doc.add_heading("If somebody cannot get in", level=1)
    doc.add_paragraph(
        "Every driver has an email address on their account, so Forgotten your "
        "password? on the sign-in screen sends them a six-digit code. It works "
        "once and expires in fifteen minutes. Failing that, ring the office and "
        "we can set a new one."
    )

    doc.save(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="drivers.csv")
    ap.add_argument("--base", default="http://localhost:3000")
    ap.add_argument("--out", default="driver-passwords.docx")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--i-mean-production", action="store_true", dest="prod")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    is_local = bool(re.match(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:|/|$)", base))

    if args.prod and is_local:
        sys.exit(f"\n  Refusing: you asked for production and --base is {base}.\n")
    if args.apply and not is_local and not args.prod:
        sys.exit(f"\n  Refusing to change {base} without --i-mean-production.\n")
    if not is_local and not base.startswith("https://"):
        sys.exit(f"\n  Refusing to send a password to {base} over plain HTTP.\n")

    drivers = read_drivers(args.file)
    print()
    print(f"  SERVER   {base}{'' if is_local else '   ** NOT this laptop **'}")
    print(f"  FILE     {args.file}  ({len(drivers)} drivers)")
    print(f"  MODE     {'APPLY' if args.apply else 'report only. Add --apply to write.'}")
    print()

    if not drivers:
        sys.exit("  Nothing to do.")

    if not args.apply:
        print("  WOULD RESET:")
        for d in drivers:
            print(f"    {d['username']:<16} {d['name']}")
        print()
        print("  Report only. No password was changed and no file was written.")
        return

    user = os.environ.get("SEED_ADMIN_USER", "admin")
    pw = os.environ.get("SEED_ADMIN_PASS", "")
    if not pw:
        sys.exit("  SEED_ADMIN_PASS is not set.")

    api = Api(base)
    status, _ = api.call("POST", "/api/login", {"username": user, "password": pw})
    if status != 200:
        sys.exit(f"  Could not sign in as {user}: HTTP {status}")

    done, failed = [], []
    for d in drivers:
        password = make_password()
        path = f"/api/users/{urllib.parse.quote(d['username'])}/password"
        status, body = api.call("POST", path, {"password": password})
        if status == 200:
            done.append({**d, "password": password})
            print(f"    {d['username']:<16} ok")
        else:
            failed.append((d["username"], status, body[:120]))
            print(f"    {d['username']:<16} FAILED HTTP {status}")

    print()
    if done:
        out = os.path.abspath(args.out)
        write_docx(done, out, base)
        print(f"  {len(done)} of {len(drivers)} reset.")
        print(f"  Written to {out}")
        print()
        print("  That file is a list of live credentials. Hand each driver their own")
        print("  line, ask them to change it, and delete the file afterwards.")
    if failed:
        print()
        print(f"  {len(failed)} FAILED and keep whatever password they had:")
        for username, status, body in failed:
            print(f"    {username}  HTTP {status}  {body}")


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (used in main)
    main()
