// The public half of an Ed25519 key, computed from its 32-byte seed (RFC 8032, section 5.1.5).
//
// A Room Census recovery file names its DID, so opening one only has to prove that the key matches
// it. An identity.pem written by flop_did.py holds the key alone, so the DID has to be computed
// from it. Web Crypto cannot hand out the public half of a private key, and exporting the key as a
// JWK would copy the seed into a JavaScript string that can never be overwritten. So the point is
// computed here instead, from bytes the page already holds and wipes afterwards.
//
// Every result is checked against Web Crypto itself in tests/pem.test.mjs: for keys Web Crypto
// generated, the public key computed here is the one it exports.
//
// The arithmetic below is not constant time. It runs on the reader's own seed, in their own tab, and
// what it produces is public, so it tells nobody anything they could not read from the DID itself.
// Script running in this page could already sign with the unlocked key, so this is not the weak link.

const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const Gx = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const Gy = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;

const mod = (a) => ((a % P) + P) % P;

function power(a, e) {
  let result = 1n;
  let base = mod(a);
  for (let bits = e; bits > 0n; bits >>= 1n) {
    if (bits & 1n) result = mod(result * base);
    base = mod(base * base);
  }
  return result;
}

/** Adds two points held as (X, Y, Z, T), the extended coordinates of the twisted Edwards curve. */
function add(p, q) {
  const a = mod((p[1] - p[0]) * (q[1] - q[0]));
  const b = mod((p[1] + p[0]) * (q[1] + q[0]));
  const c = mod(p[3] * 2n * D * q[3]);
  const d = mod(p[2] * 2n * q[2]);
  return [mod((b - a) * (d - c)), mod((d + c) * (b + a)), mod((d - c) * (d + c)), mod((b - a) * (b + a))];
}

/** The point s·B, written the way Ed25519 encodes a public key: y, with the sign of x on top. */
function encode(s) {
  let acc = [0n, 1n, 1n, 0n]; // the neutral point
  let point = [Gx, Gy, 1n, mod(Gx * Gy)];
  for (let bits = s; bits > 0n; bits >>= 1n) {
    if (bits & 1n) acc = add(acc, point);
    point = add(point, point);
  }
  const z = power(acc[2], P - 2n);
  const x = mod(acc[0] * z);
  const y = mod(acc[1] * z);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((y >> BigInt(8 * i)) & 0xffn);
  out[31] |= Number(x & 1n) << 7;
  return out;
}

/** The 32-byte public key of the Ed25519 key whose seed is `seed`. */
export async function publicFromSeed(subtle, seed) {
  if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  const hashed = new Uint8Array(await subtle.digest("SHA-512", seed));
  const clamped = hashed.subarray(0, 32);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;
  let s = 0n;
  for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(clamped[i]);
  const raw = encode(s);
  hashed.fill(0);
  return raw;
}
