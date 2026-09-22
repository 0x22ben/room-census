#!/usr/bin/env python3
"""
manifest.py: the deployment manifest, provenance layer of Room Census.

A manifest names the source commit the running code comes from, and the SHA-256 of every
repository-owned runtime Python file the census executes or imports (the standard library and
installed packages are not part of it). It is checked before anything else happens, so no census is ever
collected, stored or published by code that does not match an approved commit.

Canonical form: a manifest is one JSON object serialised with sorted keys, no spaces and ASCII
escapes, and nothing else. Its SHA-256 is therefore stable, and the published copy is named after
that digest (data/manifests/<sha256>.json), so anyone can hash the file and get its own name back.

  python manifest.py build --commit <40 hex> [--release <tag>] [--out deploy_manifest.json] [--from-disk]
  python manifest.py verify [--manifest deploy_manifest.json]

By default `build` reads the files from the source commit itself, so the digests match what a
deployment extracts from that commit; --from-disk describes the files of the current directory
instead, for a copy that is already in place.

A manifest is built from an approved commit, outside any census run, and is then referenced by the
data commits that follow: the source commit never has to contain its own manifest.

A manifest is public. It lists plain file names only: no absolute path, no host, no access detail
and no secret ever enters one, and no such detail appears in the errors raised here.
"""
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA = "room-census-manifest/1"
REPOSITORY = "https://github.com/0x22ben/room-census"
# every repository-owned runtime Python file the census executes or imports; tests are not part of a run
RUNTIME_FILES = ("census_render.py", "durable.py", "flop_did.py", "manifest.py", "room_census.py")
BASE = Path(__file__).resolve().parent
MANIFEST_FILE = BASE / "deploy_manifest.json"
PUBLIC_DIR = "data/manifests"
MAX_BYTES = 1 << 16                      # a manifest is a few hundred bytes; anything bigger is not one

HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
PLAIN_NAME = re.compile(r"^[a-z][a-z0-9_]*\.py$")     # no separator, no parent reference, no absolute path
TOP_KEYS = ("files", "generated_at_utc", "schema", "source")
SOURCE_KEYS = ("commit", "release", "repository")
FILE_KEYS = ("bytes", "path", "sha256")


class ManifestError(RuntimeError):
    """The manifest is missing, malformed, or does not describe the code that is about to run."""


def canonical_bytes(doc) -> bytes:
    """The one serialisation a manifest may have; its SHA-256 is the manifest digest."""
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def digest(doc) -> str:
    return hashlib.sha256(canonical_bytes(doc)).hexdigest()


def public_path(sha: str) -> str:
    """Immutable published name: the file is its own checksum."""
    return f"{PUBLIC_DIR}/{sha}.json"


def file_digest(path: Path):
    data = path.read_bytes()
    return hashlib.sha256(data).hexdigest(), len(data)


def from_disk(base: Path):
    """Reads the files as they are on disk, which is what a deployed copy runs."""
    def read(name):
        path = Path(base) / name
        if not path.is_file():
            raise ManifestError(f"{name} is missing; it cannot be described")
        return path.read_bytes()
    return read


def from_commit(commit: str, repo: Path = BASE):
    """Reads the files as the source commit stores them, byte for byte, whatever the local checkout
    does with line endings. This is what a deployment extracts, so this is what it will run."""
    def read(name):
        out = subprocess.run(["git", "-C", str(repo), "cat-file", "blob", f"{commit}:{name}"],
                             capture_output=True)
        if out.returncode != 0:
            raise ManifestError(f"{name} cannot be read from the source commit")
        return out.stdout
    return read


def build(commit: str, base: Path = BASE, release=None, now=None, reader=None) -> dict:
    """Describes every runtime file under the given source commit, as `reader` returns them."""
    if not isinstance(commit, str) or not HEX40.match(commit):
        raise ManifestError("source commit must be 40 lowercase hexadecimal characters")
    if release is not None and (not isinstance(release, str) or not release.strip()):
        raise ManifestError("release must be a non-empty string or absent")
    read = reader or from_disk(base)
    files = []
    for name in sorted(RUNTIME_FILES):
        data = read(name)
        files.append({"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return {"schema": SCHEMA,
            "source": {"repository": REPOSITORY, "commit": commit, "release": release},
            "generated_at_utc": moment.isoformat().replace("+00:00", "Z"),
            "files": files}


# ---------- validation ----------
#
# Every check below raises ManifestError. None of them relies on assert, so they hold under python -O.

def exact_keys(obj, keys, what):
    if not isinstance(obj, dict):
        raise ManifestError(f"{what} is not an object")
    missing = sorted(set(keys) - set(obj))
    extra = sorted(set(obj) - set(keys))
    if missing:
        raise ManifestError(f"{what} is incomplete, missing {', '.join(missing)}")
    if extra:
        raise ManifestError(f"{what} has unexpected fields: {', '.join(str(k)[:40] for k in extra)}")


def check_source(source):
    exact_keys(source, SOURCE_KEYS, "source")
    if not isinstance(source["commit"], str) or not HEX40.match(source["commit"]):
        raise ManifestError("source commit must be 40 lowercase hexadecimal characters")
    if source["repository"] != REPOSITORY:
        raise ManifestError("source repository is not the repository of this program")
    release = source["release"]
    if release is not None and (not isinstance(release, str) or not release.strip()):
        raise ManifestError("release must be a non-empty string or null")


def check_moment(value):
    if not isinstance(value, str):
        raise ManifestError("generated_at_utc is not a string")
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        raise ManifestError("generated_at_utc is not an ISO 8601 timestamp") from None
    if moment.tzinfo is None:
        raise ManifestError("generated_at_utc has no time zone")
    if moment.utcoffset() != timedelta(0):
        raise ManifestError("generated_at_utc is not in UTC")


def check_files(files):
    if not isinstance(files, list) or not files:
        raise ManifestError("files is not a non-empty list")
    names = []
    for entry in files:
        exact_keys(entry, FILE_KEYS, "file entry")
        name = entry["path"]
        if not isinstance(name, str) or not PLAIN_NAME.match(name):
            raise ManifestError(f"forbidden path {str(name)[:40]!r}: a manifest lists plain file names only")
        if not isinstance(entry["sha256"], str) or not HEX64.match(entry["sha256"]):
            raise ManifestError(f"{name}: sha256 must be 64 lowercase hexadecimal characters")
        size = entry["bytes"]
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ManifestError(f"{name}: bytes must be a non-negative integer")
        names.append(name)
    duplicates = sorted({n for n in names if names.count(n) > 1})
    if duplicates:
        raise ManifestError(f"duplicate entries for {', '.join(duplicates)}")
    if names != sorted(names):
        raise ManifestError("file entries are not sorted by path")
    missing = sorted(set(RUNTIME_FILES) - set(names))
    if missing:
        raise ManifestError(f"the manifest does not cover {', '.join(missing)}")
    extra = sorted(set(names) - set(RUNTIME_FILES))
    if extra:
        raise ManifestError(f"the manifest describes files the census does not run: {', '.join(extra)}")


def parse(data: bytes) -> dict:
    """Bytes to a valid manifest: rejects anything that is not one, in canonical form."""
    if not isinstance(data, bytes):
        raise ManifestError("a manifest is read as bytes")
    if len(data) > MAX_BYTES:
        raise ManifestError("the manifest file is too large to be a manifest")
    try:
        doc = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ManifestError("the manifest is not valid UTF-8 JSON") from None
    if not isinstance(doc, dict):
        raise ManifestError("the manifest is not a JSON object")
    exact_keys(doc, TOP_KEYS, "manifest")
    if doc["schema"] != SCHEMA:
        raise ManifestError(f"unknown manifest schema {str(doc['schema'])[:40]!r}, expected {SCHEMA}")
    check_source(doc["source"])
    check_moment(doc["generated_at_utc"])
    check_files(doc["files"])
    if canonical_bytes(doc) != data:
        raise ManifestError("the manifest is not in canonical form (sorted keys, no spaces, ASCII escapes)")
    return doc


def verify_files(doc, base: Path = BASE):
    """Compares every described file with the file that would actually run."""
    root = Path(base).resolve()
    for entry in doc["files"]:
        path = (root / entry["path"]).resolve()
        if path.parent != root:
            raise ManifestError(f"{entry['path']} resolves outside the program directory")
        if not path.is_file():
            raise ManifestError(f"{entry['path']} is described by the manifest but missing")
        sha, size = file_digest(path)
        if size != entry["bytes"] or sha != entry["sha256"]:
            raise ManifestError(f"{entry['path']} does not match the manifest "
                                f"(sha256 {sha[:12]}..., {size} bytes on disk)")


def verify(path: Path = MANIFEST_FILE, base: Path = BASE):
    """Full check. Returns the manifest and the SHA-256 of its canonical bytes."""
    try:
        data = Path(path).read_bytes()
    except OSError:
        raise ManifestError(f"{Path(path).name} is missing or unreadable") from None
    doc = parse(data)
    verify_files(doc, base)
    return doc, hashlib.sha256(data).hexdigest()


def provenance(doc, sha: str) -> dict:
    """The public provenance block carried by every snapshot, by latest.json and by identity.json."""
    return {"manifest_sha256": sha, "manifest": public_path(sha), "commit": doc["source"]["commit"],
            "release": doc["source"]["release"], "repository": doc["source"]["repository"]}


# ---------- command line ----------

def option(args, name, default=None):
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else default


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    command = args[0] if args else ""
    if command == "build":
        commit = option(args, "--commit", "")
        reader = None if "--from-disk" in args else from_commit(commit)
        doc = build(commit, release=option(args, "--release"), reader=reader)
        data = canonical_bytes(doc)
        out = Path(option(args, "--out", str(MANIFEST_FILE)))
        out.write_bytes(data)
        sha = hashlib.sha256(data).hexdigest()
        print(f"{out.name}: {len(data)} bytes, sha256 {sha}")
        print(f"published as {public_path(sha)}")
        return 0
    if command == "verify":
        doc, sha = verify(Path(option(args, "--manifest", str(MANIFEST_FILE))))
        print(f"manifest {sha}\nsource commit {doc['source']['commit']}")
        for entry in doc["files"]:
            print(f"  ok {entry['path']} {entry['sha256']} {entry['bytes']} bytes")
        return 0
    print(__doc__.strip())
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ManifestError as error:
        print("manifest error:", error)
        sys.exit(1)
