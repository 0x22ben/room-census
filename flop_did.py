#!/usr/bin/env python3
"""
flop_did.py : identité DID (did:key Ed25519) pour Technocore / FLOP.

Commandes :
  python flop_did.py init              crée l'identité (refuse d'écraser une identité existante)
  python flop_did.py show              affiche le DID public
  python flop_did.py sign ROOM TEXTE   signe un message et affiche l'URL say-signed (n'envoie rien)
  python flop_did.py say ROOM TEXTE    signe ET publie le message sur technocore.chat, archive la preuve

Fichiers créés dans le dossier du script :
  identity.pem     clé privée chiffrée (ne jamais partager)
  passphrase.txt   mot de passe de la clé (à déplacer dans un gestionnaire de mots de passe)
  did.txt          DID public (partageable)
  proofs.jsonl     archive locale des messages publiés (preuve horodatée)

Spec suivie (technocore.chat/llms.txt) :
  DID       did:key:z6Mk... (multicodec ed25519-pub 0xed01, multibase base58btc)
  signature Ed25519 sur "<room>|<nonce>|<text>" en UTF-8, base64url sans padding (86 caractères)
  nonce     entier strictement croissant par clé et par room (ici : horloge en millisecondes)
  URL       /r/<room>/say-signed/<did>/<sig>/<nonce>/<text>

Dépendance unique : pip install cryptography
"""
import base64
import json
import os
import re
import secrets
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

BASE = Path(__file__).resolve().parent
KEY_FILE = BASE / "identity.pem"
PASS_FILE = BASE / "passphrase.txt"
DID_FILE = BASE / "did.txt"
PROOF_FILE = BASE / "proofs.jsonl"
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
        sys.exit("Aucune identité : lance d'abord  python flop_did.py init")
    passphrase = os.environ.get("FLOP_DID_PASSPHRASE")
    if not passphrase:
        if not PASS_FILE.exists():
            sys.exit("Mot de passe introuvable : définis FLOP_DID_PASSPHRASE ou remets passphrase.txt")
        passphrase = PASS_FILE.read_text(encoding="utf-8").strip()
    return serialization.load_pem_private_key(KEY_FILE.read_bytes(), password=passphrase.encode())


def public_did(key: Ed25519PrivateKey) -> str:
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return did_from_public(raw)


def cmd_init():
    if KEY_FILE.exists():
        sys.exit("identity.pem existe déjà : je n'écrase jamais une identité.")
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
    print("Identité créée.")
    print("DID :", did)
    print("Clé privée chiffrée : identity.pem ; mot de passe : passphrase.txt (à sauvegarder séparément)")


def sign(room: str, text: str):
    if not ROOM_RE.match(room):
        sys.exit("Nom de room invalide (a-z, 0-9, - et _, 48 caractères max).")
    if "\n" in text or "\r" in text or len(text) > 4096:
        sys.exit("Le texte doit tenir sur une ligne et faire 4096 caractères max.")
    key = load_key()
    did = public_did(key)
    nonce = str(int(time.time() * 1000))
    payload = f"{room}|{nonce}|{text}".encode("utf-8")
    sig = base64.urlsafe_b64encode(key.sign(payload)).rstrip(b"=").decode()
    # vérification locale avant tout envoi
    key.public_key().verify(base64.urlsafe_b64decode(sig + "=="), payload)
    assert len(sig) == 86 and sig[-1] in "AQgw", "signature non canonique"
    path = "/r/{}/say-signed/{}/{}/{}/{}".format(
        room, did, sig, nonce, urllib.parse.quote(text, safe="")
    )
    return did, sig, nonce, SERVER + path


def cmd_sign(room, text):
    did, sig, nonce, url = sign(room, text)
    print("DID   :", did)
    print("nonce :", nonce)
    print("URL   :", url)
    print("(rien n'a été envoyé)")


def cmd_say(room, text):
    did, sig, nonce, url = sign(room, text)
    req = urllib.request.Request(url, headers={"User-Agent": "flop-did/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8", "replace")
        status = resp.status
    proof = {
        "sent_at_utc": datetime.now(timezone.utc).isoformat(),
        "room": room,
        "did": did,
        "nonce": nonce,
        "text": text,
        "sig": sig,
        "http_status": status,
        "server_response": body[:2000],
    }
    with PROOF_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(proof, ensure_ascii=False) + "\n")
    print("Publié (HTTP", status, ") :", body[:500])
    print("Preuve archivée dans proofs.jsonl")


def main():
    args = sys.argv[1:]
    if args == ["init"]:
        cmd_init()
    elif args == ["show"]:
        print(DID_FILE.read_text().strip() if DID_FILE.exists() else public_did(load_key()))
    elif len(args) >= 3 and args[0] in ("sign", "say"):
        room, text = args[1], " ".join(args[2:])
        (cmd_sign if args[0] == "sign" else cmd_say)(room, text)
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
