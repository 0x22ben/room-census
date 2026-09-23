// Reading the encrypted identity.pem that flop_did.py writes, in the browser, with Web Crypto only.
// It is the same Ed25519 identity as a Room Census recovery file: only the container differs.
//
// The file is an RFC 5958 EncryptedPrivateKeyInfo, exactly as Python's cryptography writes it for
// `BestAvailableEncryption`:
//
//   SEQUENCE                                     EncryptedPrivateKeyInfo
//     SEQUENCE                                   encryptionAlgorithm
//       OID 1.2.840.113549.1.5.13                PBES2
//       SEQUENCE                                 PBES2-params
//         SEQUENCE                               keyDerivationFunc
//           OID 1.2.840.113549.1.5.12            PBKDF2
//           SEQUENCE   OCTET STRING salt, INTEGER iterations, SEQUENCE(OID 1.2.840.113549.2.9, NULL)
//         SEQUENCE                               encryptionScheme
//           OID 2.16.840.1.101.3.4.1.42          aes-256-CBC, with a 16-byte IV
//     OCTET STRING                               the encrypted PKCS#8 private key
//
// Nothing else is accepted: another algorithm, another key derivation or an unencrypted key is
// refused rather than guessed at. Web Crypto removes the PKCS#7 padding and fails on a wrong
// passphrase, so a bad password and a damaged file both end the same way: nothing is returned.

const OID = {
  pbes2: "2a864886f70d01050d",
  pbkdf2: "2a864886f70d01050c",
  hmacSha256: "2a864886f70d0209",
  aes256Cbc: "60864801650304012a",
};

/** A problem with a PEM file. `code` is safe to show; no message ever carries key material. */
export class PemError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** One DER element at `at`: its tag, its contents and where the next one starts. */
function read(der, at) {
  if (at + 2 > der.length) throw new PemError("format", "This file is not a Room Census identity file.");
  const tag = der[at];
  let length = der[at + 1];
  let start = at + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 3 || start + n > der.length) throw new PemError("format", "This file is not a Room Census identity file.");
    length = 0;
    for (let i = 0; i < n; i++) length = (length << 8) | der[start + i];
    start += n;
  }
  const end = start + length;
  if (end > der.length) throw new PemError("format", "This file is not a Room Census identity file.");
  return { tag, value: der.subarray(start, end), end };
}

/** Reads the `count` elements of a SEQUENCE, refusing a shorter or longer one. */
function parts(value, count) {
  const out = [];
  let at = 0;
  while (at < value.length) {
    const part = read(value, at);
    out.push(part);
    at = part.end;
  }
  if (out.length !== count) throw new PemError("unsupported", "This identity file is not the one flop_did.py writes.");
  return out;
}

const expect = (part, tag) => {
  if (!part || part.tag !== tag) throw new PemError("format", "This file is not a Room Census identity file.");
  return part;
};
const oid = (part) => hex(expect(part, 0x06).value);
const integer = (part) => {
  const v = expect(part, 0x02).value;
  if (v.length === 0 || v.length > 4 || v[0] & 0x80) throw new PemError("format", "This file is not a Room Census identity file.");
  return v.reduce((n, b) => (n << 8) | b, 0);
};

/** The base64 body of one PEM block, as bytes. */
export function pemBody(text, label) {
  const block = new RegExp(`-----BEGIN ${label}-----([\\sA-Za-z0-9+/=]+)-----END ${label}-----`).exec(String(text));
  if (!block) return null;
  try {
    const bin = atob(block[1].replace(/\s+/g, ""));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Opens an encrypted identity.pem and returns its PKCS#8 private key bytes. The caller wipes them.
 * Throws a PemError: "format" (not this kind of file), "unsupported" (another algorithm) or
 * "password" (wrong passphrase, or the file was changed).
 */
export async function openPem(subtle, text, passphrase) {
  if (pemBody(text, "PRIVATE KEY")) {
    throw new PemError("unsupported", "This identity file is not encrypted. Room Census only opens a passphrase-protected identity.pem.");
  }
  const der = pemBody(text, "ENCRYPTED PRIVATE KEY");
  if (!der) throw new PemError("format", "This file is not an encrypted identity.pem written by flop_did.py.");

  const whole = read(der, 0);
  // nothing may follow the structure, and nothing may be hidden inside it
  if (whole.end !== der.length) throw new PemError("format", "This identity file has extra bytes after the key.");
  const outer = parts(expect(whole, 0x30).value, 2);
  const algorithm = parts(expect(outer[0], 0x30).value, 2);
  const encrypted = expect(outer[1], 0x04).value;
  if (oid(algorithm[0]) !== OID.pbes2) throw new PemError("unsupported", "This identity file uses a protection Room Census cannot open.");

  const pbes2 = parts(expect(algorithm[1], 0x30).value, 2);
  const kdf = parts(expect(pbes2[0], 0x30).value, 2);
  const scheme = parts(expect(pbes2[1], 0x30).value, 2);
  if (oid(kdf[0]) !== OID.pbkdf2 || oid(scheme[0]) !== OID.aes256Cbc) {
    throw new PemError("unsupported", "This identity file uses a protection Room Census cannot open.");
  }
  // salt, iterations and the hash, in that order: a key length or any other field is refused
  const params = parts(expect(kdf[1], 0x30).value, 3);
  const salt = expect(params[0], 0x04).value;
  const iterations = integer(params[1]);
  const prf = parts(expect(params[2], 0x30).value, 2);
  if (oid(prf[0]) !== OID.hmacSha256 || prf[1].tag !== 0x05 || prf[1].value.length !== 0) {
    throw new PemError("unsupported", "This identity file uses a protection Room Census cannot open.");
  }
  const iv = expect(scheme[1], 0x04).value;
  if (salt.length < 8 || iv.length !== 16 || iterations < 1000 || iterations > 10_000_000 || encrypted.length === 0 || encrypted.length % 16 !== 0) {
    throw new PemError("format", "This identity file is damaged.");
  }

  const base = await subtle.importKey("raw", new TextEncoder().encode(String(passphrase ?? "")), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-CBC", length: 256 }, false, ["decrypt"]);
  try {
    // AES-CBC in Web Crypto checks and removes the PKCS#7 padding: a wrong passphrase fails here
    return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, key, encrypted));
  } catch {
    throw new PemError("password", "Wrong passphrase, or the file was changed.");
  }
}

/**
 * The DID a did.txt holds, or null when it holds anything else. The file is optional, and it is only
 * ever a check, so it must be one DID and nothing more: a DID with text around it is not one.
 */
export function didFromText(text) {
  const only = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.exec(String(text ?? "").trim());
  return only ? only[0] : null;
}

/** The passphrase held in passphrase.txt: its first line, trimmed of the line ending only. */
export const passphraseFromText = (text) => String(text ?? "").split(/\r?\n/)[0];
