"""did:key identity and signatures, with a throwaway key in a temporary directory."""
import base64
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

import flop_did

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    return n.to_bytes((n.bit_length() + 7) // 8, "big")


class Identity(unittest.TestCase):
    def setUp(self):
        # every change below is undone by a cleanup registered right after it (run in reverse order)
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        for k, name in (("KEY_FILE", "identity.pem"), ("PASS_FILE", "passphrase.txt"),
                        ("DID_FILE", "did.txt"), ("PROOF_FILE", "proofs.jsonl")):
            patcher = mock.patch.object(flop_did, k, self.tmp / name)
            patcher.start()
            self.addCleanup(patcher.stop)
        # patch.dict restores os.environ exactly as it was, whatever the test sets or removes
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("FLOP_DID_PASSPHRASE", None)
        flop_did.cmd_init()

    def test_did_key_format(self):
        did = flop_did.DID_FILE.read_text().strip()
        self.assertTrue(did.startswith("did:key:z6Mk"))
        self.assertEqual(len(did), 56)
        self.assertEqual(b58decode(did[9:])[:2], b"\xed\x01")

    def test_init_never_overwrites(self):
        with self.assertRaises(SystemExit):
            flop_did.cmd_init()

    def test_signature_verifies_over_room_nonce_text(self):
        did, sig, nonce, url = flop_did.sign("room-census", "Room Census #2 | https://example.org/a//b")
        self.assertEqual(len(sig), 86)
        self.assertIn(sig[-1], "AQgw")
        self.assertTrue(nonce.isdigit() and 1 <= len(nonce) <= 19)
        pub = Ed25519PublicKey.from_public_bytes(b58decode(did[9:])[2:])
        pub.verify(base64.urlsafe_b64decode(sig + "=="), f"room-census|{nonce}|Room Census #2 | https://example.org/a//b".encode())

    def test_passphrase_from_environment_takes_precedence(self):
        os.environ["FLOP_DID_PASSPHRASE"] = "wrong passphrase"      # undone by patch.dict in setUp
        with self.assertRaises(ValueError):
            flop_did.load_key()

    def test_invalid_room_or_multiline_text_is_refused(self):
        for room, text in (("Bad Room", "x"), ("room-census", "two\nlines"), ("room-census", "x" * 4097)):
            with self.subTest(room=room), self.assertRaises(SystemExit):
                flop_did.sign(room, text)


if __name__ == "__main__":
    unittest.main()
