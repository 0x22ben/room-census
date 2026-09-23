// Sorting the files a reader picks when opening their DID.
//
// A file is taken for what its name says it is, never for what its contents look like: did.txt is
// always the DID check, passphrase.txt is always the passphrase, and anything else must be the one
// key container. So a did.txt that holds something else is refused instead of quietly becoming a
// passphrase, and a selection that is not exactly one key, with at most one of each helper, is
// refused before a single byte is read.

export const MAX_FILES = 3;
export const MAX_BYTES = 64 * 1024;

const KINDS = { "did.txt": "did", "passphrase.txt": "passphrase" };
const kindOf = (name) => KINDS[name] ?? (name.endsWith(".json") ? "key" : name.endsWith(".pem") ? "key" : null);

/**
 * Sorts `files` ({name, size}) into {key, passphrase, did}, or returns {problem} with a sentence to
 * show. Names are matched in lower case, and a path is reduced to its last segment.
 */
export function sortFiles(files) {
  const chosen = [...files];
  if (chosen.length === 0) return { problem: "Choose your DID file." };
  if (chosen.length > MAX_FILES) {
    return { problem: `Choose at most ${MAX_FILES} files: your DID file, and optionally passphrase.txt and did.txt.` };
  }
  const found = {};
  for (const file of chosen) {
    const name = String(file.name ?? "").split(/[\\/]/).pop().toLowerCase();
    const kind = kindOf(name);
    if (!kind) {
      return { problem: `Room Census does not know what to do with ${name}. Choose your .json recovery file or your identity.pem, and optionally passphrase.txt and did.txt.` };
    }
    if (found[kind]) {
      return { problem: kind === "key"
        ? "Choose one DID file at a time: either your .json recovery file or your identity.pem."
        : `Only one ${name} can be used at a time.` };
    }
    if (typeof file.size !== "number" || file.size > MAX_BYTES) {
      return { problem: `${name} is too large, or its size cannot be read, to be one of these files. Nothing was read.` };
    }
    found[kind] = file;
  }
  if (!found.key) return { problem: "None of these files is a DID file. Choose your .json recovery file or your identity.pem." };
  return { key: found.key, passphrase: found.passphrase ?? null, did: found.did ?? null };
}
