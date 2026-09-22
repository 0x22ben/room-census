#!/usr/bin/env python3
"""
flop_did.py: did:key (Ed25519) identity and signed messages for Technocore / FLOP.

Commands:
  python flop_did.py init              create the identity (never overwrites an existing one)
  python flop_did.py show              print the public DID
  python flop_did.py sign ROOM TEXT    sign a message and print the say-signed URL (sends nothing)
  python flop_did.py say ROOM TEXT     sign AND publish the message on technocore.chat (POST), archive the proof;
                                       a text that already has a receipt for this room is not sent again
  python flop_did.py say --repeat ROOM TEXT   publish the same text again, on purpose

Files created next to the script:
  identity.pem     encrypted private key (never share)
  passphrase.txt   key passphrase (move it to a password manager; FLOP_DID_PASSPHRASE takes precedence)
  did.txt          public DID (shareable)
  proofs.jsonl     durable receipts of published messages (timestamped proof, written atomically)
  nonces.json      last nonce used per room (see durable.NonceStore)
  census.lock      kernel lock shared with room_census.py (see durable.ProcessLock)
  say_pending.json a manual message signed but not yet confirmed in the room (see cmd_say)

Spec followed (technocore.chat/llms.txt):
  DID        did:key:z6Mk... (multicodec ed25519-pub 0xed01, multibase base58btc)
  signature  Ed25519 over "<room>|<nonce>|<text>" in UTF-8, unpadded base64url (86 characters)
  nonce      strictly increasing integer per key and per room: max(millisecond clock, last + 1),
             persisted in nonces.json under the shared lock
  URL        /r/<room>/say-signed/<did>/<sig>/<nonce>/<text>

Single dependency: pip install cryptography
"""
import base64
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import durable

BASE = Path(__file__).resolve().parent
KEY_FILE = BASE / "identity.pem"
PASS_FILE = BASE / "passphrase.txt"
DID_FILE = BASE / "did.txt"
PROOF_FILE = BASE / "proofs.jsonl"
NONCE_FILE = BASE / "nonces.json"
LOCK_FILE = BASE / "census.lock"
SAY_JOURNAL = BASE / "say_pending.json"      # a manual message signed but not yet confirmed in the room
SAY_SCHEMA = "flop-did-say-pending/1"
NONCE_RE = re.compile(r"^[1-9][0-9]{0,18}$")
SERVER = "https://technocore.chat"
ROOM_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    pad = len(data) - len(data.lstrip(b"\0"))
    return "1" * pad + out


def did_from_public(raw_pub: bytes) -> str:
    return "did:key:z" + b58encode(b"\xed\x01" + raw_pub)


def load_key() -> Ed25519PrivateKey:
    if not KEY_FILE.exists():
        sys.exit("No identity: run  python flop_did.py init  first")
    passphrase = os.environ.get("FLOP_DID_PASSPHRASE")
    if not passphrase:
        if not PASS_FILE.exists():
            sys.exit("Passphrase not found: set FLOP_DID_PASSPHRASE or restore passphrase.txt")
        passphrase = PASS_FILE.read_text(encoding="utf-8").strip()
    return serialization.load_pem_private_key(KEY_FILE.read_bytes(), password=passphrase.encode())


def public_did(key: Ed25519PrivateKey) -> str:
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return did_from_public(raw)


def cmd_init():
    if KEY_FILE.exists():
        sys.exit("identity.pem already exists: an identity is never overwritten.")
    key = Ed25519PrivateKey.generate()
    passphrase = secrets.token_urlsafe(32)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.BestAvailableEncryption(passphrase.encode()),
    )
    KEY_FILE.write_bytes(pem)
    PASS_FILE.write_text(passphrase + "\n", encoding="utf-8")
    did = public_did(key)
    DID_FILE.write_text(did + "\n", encoding="utf-8")
    print("Identity created.")
    print("DID:", did)
    print("Encrypted private key: identity.pem; passphrase: passphrase.txt (store it separately)")


class PublishRefused(RuntimeError):
    """The server answered and refused the message (HTTP error): it was not stored this time."""


def sign(room: str, text: str, nonce: str = None):
    """Signs `room|nonce|text`. Publishing callers must pass a nonce reserved from durable.NonceStore;
    without one (dry runs, `sign` command) the millisecond clock is used and nothing is persisted."""
    if not ROOM_RE.match(room):
        sys.exit("Invalid room name (a-z, 0-9, - and _, 48 characters max).")
    if "\n" in text or "\r" in text or len(text) > 4096:
        sys.exit("The text must be a single line of 4096 characters max.")
    if nonce is not None and not NONCE_RE.match(str(nonce)):
        sys.exit("The nonce must be 1 to 19 digits.")
    key = load_key()
    did = public_did(key)
    nonce = str(nonce) if nonce is not None else str(int(time.time() * 1000))
    payload = f"{room}|{nonce}|{text}".encode("utf-8")
    sig = base64.urlsafe_b64encode(key.sign(payload)).rstrip(b"=").decode()
    # local check before anything is sent
    key.public_key().verify(base64.urlsafe_b64decode(sig + "=="), payload)
    assert len(sig) == 86 and sig[-1] in "AQgw", "non-canonical signature"
    path = "/r/{}/say-signed/{}/{}/{}/{}".format(
        room, did, sig, nonce, urllib.parse.quote(text, safe="")
    )
    return did, sig, nonce, SERVER + path


def cmd_sign(room, text):
    did, sig, nonce, url = sign(room, text)
    print("DID  :", did)
    print("nonce:", nonce)
    print("URL  :", url)
    print("(nothing was sent)")


def post_signed(room, did, sig, nonce, text):
    """Sends an already signed message over the POST lane (the text travels in the body, so URLs with
    "//" reach the server unchanged). Returns (status, body). Raises PublishRefused when the server
    answers with an error; any other exception (timeout, connection reset) means the outcome is
    unknown and the caller must check the room before trying again."""
    body_json = json.dumps({"did": did, "sig": sig, "nonce": str(nonce), "text": text}).encode("utf-8")
    req = urllib.request.Request(f"{SERVER}/r/{room}", data=body_json, method="POST",
                                 headers={"User-Agent": "flop-did/1.0", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        # the server names the refused field on the first line of the body
        raise PublishRefused(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from None


def read_proofs():
    """Proof lines, oldest first. A line that is not a JSON object is skipped (it can only come from
    appends made before proofs were written atomically)."""
    if not PROOF_FILE.exists():
        return []
    proofs = []
    for line in PROOF_FILE.read_text(encoding="utf-8").splitlines():
        try:
            p = json.loads(line)
        except ValueError:
            continue
        if isinstance(p, dict):
            proofs.append(p)
    return proofs


def find_proof(room, did, text):
    """The durable receipt of a confirmed message with this exact room, author and text, if any."""
    for p in reversed(read_proofs()):
        if p.get("room") == room and p.get("did") == did and p.get("text") == text:
            return p
    return None


def record_proof(room, did, sig, nonce, text, status, body):
    """Durable receipt of a message confirmed in the room, once per (room, nonce). The whole file is
    rewritten atomically, so a crash never leaves a truncated receipt; callers drop their pending
    journal only after this returns."""
    nonce = str(nonce)
    for p in read_proofs():
        if p.get("room") == room and str(p.get("nonce")) == nonce:
            return p
    proof = {"sent_at_utc": datetime.now(timezone.utc).isoformat(), "room": room, "did": did, "nonce": nonce,
             "text": text, "sig": sig, "http_status": status, "server_response": (body or "")[:2000]}
    existing = PROOF_FILE.read_text(encoding="utf-8") if PROOF_FILE.exists() else ""
    if existing and not existing.endswith("\n"):
        existing += "\n"
    durable.atomic_write(PROOF_FILE, existing + json.dumps(proof, ensure_ascii=False) + "\n")
    return proof


def fetch_export(room):
    """Raw JSONL of every record Technocore still retains for `room`. The endpoint takes no query
    parameter, so none is added."""
    req = urllib.request.Request(f"{SERVER}/r/{room}/export", headers={"User-Agent": "flop-did/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8")


def signed_status(pending):
    """True if the signed message (did, nonce, sig) is in the room's full retained export, False if its
    absence is proven (the retained history reaches back to before it was signed), None otherwise."""
    try:
        records = [json.loads(line) for line in fetch_export(pending["room"]).splitlines() if line.strip()]
        if not all(isinstance(r, dict) for r in records):
            return None
        for r in records:
            if (r.get("from") == pending["did"] and str(r.get("nonce")) == pending["nonce"]
                    and r.get("sig") == pending["sig"]):
                return True
        signed_at = datetime.fromisoformat(pending["created_utc"])
        oldest = min(datetime.fromisoformat(r["ts"].replace("Z", "+00:00")) for r in records) if records else None
    except Exception:
        return None
    return False if oldest is not None and oldest <= signed_at else None


def _send_pending(pending):
    """Sends the signed payload once. Returns (True, status, body) when it is known to be in the room,
    (False, None, None) when it is proven absent, (None, None, None) when this cannot be established."""
    try:
        status, body = post_signed(pending["room"], pending["did"], pending["sig"], pending["nonce"], pending["text"])
        return True, status, body
    except PublishRefused as e:
        print(f"Refused by the server ({e}); checking the room", flush=True)
    except Exception as e:
        print(f"Outcome unknown ({type(e).__name__}: {e}); checking the room", flush=True)
    return signed_status(pending), None, None


def _load_say_journal():
    if not SAY_JOURNAL.exists():
        return None
    try:
        pending = json.loads(SAY_JOURNAL.read_text(encoding="utf-8"))
        if not (isinstance(pending, dict) and pending.get("schema") == SAY_SCHEMA
                and all(isinstance(pending.get(k), str) for k in ("room", "did", "nonce", "sig", "text", "created_utc"))
                and NONCE_RE.match(pending["nonce"])):
            raise ValueError("unexpected fields")
    except ValueError as e:
        sys.exit(f"{SAY_JOURNAL.name} is unusable ({e}); it is kept for inspection and nothing is sent.")
    return pending


def _resolve_say_journal():
    """Settles a manual message left by an interrupted `say`: already in the room, or proven absent
    and sent again with the same nonce and signature. Never signs it again with a new nonce."""
    pending = _load_say_journal()
    if pending is None:
        return None
    state = signed_status(pending)
    status = body = None
    if state is False:
        state, status, body = _send_pending(pending)
    if state is not True:
        sys.exit(f"The previous message (nonce {pending['nonce']}) cannot be confirmed; {SAY_JOURNAL.name} "
                 "is kept and nothing new is sent. Run the command again later.")
    proof = record_proof(pending["room"], pending["did"], pending["sig"], pending["nonce"], pending["text"], status, body)
    SAY_JOURNAL.unlink(missing_ok=True)
    print(f"Previous message (nonce {pending['nonce']}) confirmed in the room.", flush=True)
    return pending, proof


def cmd_say(room, text, repeat=False):
    """Manual publication, crash-safe: shared lock, reserved nonce, signed payload journalled before it
    is sent, confirmation from the room's full export when the response is lost, durable receipt in
    proofs.jsonl before the journal is dropped.

    Running the command again after an interruption finishes the previous message instead of signing
    it a second time. A message whose exact room and text already have a receipt is not published
    again: its existing proof is returned without reserving a nonce. Publishing the same text again on
    purpose requires repeat=True (command line: `say --repeat ROOM TEXT`)."""
    try:
        lock = durable.ProcessLock(LOCK_FILE).acquire()
    except durable.LockBusy:
        sys.exit("A census run holds the lock; try again when it has finished.")
    with lock:
        resolved = _resolve_say_journal()
        if not repeat:
            if resolved and resolved[0]["room"] == room and resolved[0]["text"] == text:
                print("This exact message was already published; nothing new is sent.")
                return resolved[1]
            own = DID_FILE.read_text(encoding="utf-8").strip() if DID_FILE.exists() else public_did(load_key())
            receipt = find_proof(room, own, text)
            if receipt is not None:
                print(f"This exact message was already published (nonce {receipt.get('nonce')}); nothing new is "
                      "sent. Use --repeat to publish it again on purpose.")
                return receipt
        nonce = durable.NonceStore(NONCE_FILE, lock).reserve(room)
        did, sig, nonce, _ = sign(room, text, nonce=nonce)
        pending = {"schema": SAY_SCHEMA, "room": room, "did": did, "nonce": nonce, "sig": sig, "text": text,
                   "created_utc": datetime.now(timezone.utc).isoformat()}
        durable.atomic_write(SAY_JOURNAL, json.dumps(pending, ensure_ascii=False, sort_keys=True))
        state, status, body = _send_pending(pending)
        if state is False:
            SAY_JOURNAL.unlink(missing_ok=True)                 # proven not stored: nothing to finish
            sys.exit(f"The message was not published (nonce {nonce}).")
        if state is None:
            sys.exit(f"The outcome cannot be confirmed; {SAY_JOURNAL.name} is kept. Run the same command again "
                     "later: it will finish this message, never sign it twice.")
        proof = record_proof(room, did, sig, nonce, text, status, body)
        SAY_JOURNAL.unlink(missing_ok=True)
    print("Published (HTTP", status or "confirmed in the room", "):", (body or "")[:500])
    print("Proof archived in proofs.jsonl")
    return proof


def main():
    args = sys.argv[1:]
    if args == ["init"]:
        cmd_init()
    elif args == ["show"]:
        print(DID_FILE.read_text().strip() if DID_FILE.exists() else public_did(load_key()))
    elif len(args) >= 4 and args[0] == "say" and args[1] == "--repeat":
        cmd_say(args[2], " ".join(args[3:]), repeat=True)
    elif len(args) >= 3 and args[0] in ("sign", "say") and not args[1].startswith("--"):
        room, text = args[1], " ".join(args[2:])
        (cmd_sign if args[0] == "sign" else cmd_say)(room, text)
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
