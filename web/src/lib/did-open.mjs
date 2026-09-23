// Opening a DID from the files a reader picked, for every page that does it.
//
// Both entry points, My DID and Write, go through this one function, so a file is sorted, checked and
// opened the same way everywhere: one key container in either local backup format, an optional
// passphrase.txt that only fills in for an empty field, and an optional did.txt that must hold one
// did:key value and must name the DID the key derives, or nothing is opened.
import { sortFiles } from "./did-files.mjs";
import { didFromText, openBackup, openIdentityPem, passphraseFromText, PemError, WalletError } from "./did-wallet.mjs";

/**
 * Returns {identity, pem} for the chosen files, or {problem} with a sentence to show. `pem` is the
 * encrypted PEM text when that is what was opened, so a page can offer a recovery file for the same
 * key; it is null for a recovery file. Nothing here reaches the network.
 */
export async function openChosen(subtle, files, typed) {
  const sorted = sortFiles(files);
  if (sorted.problem) return { problem: sorted.problem };
  const keyText = await sorted.key.text();
  const didText = sorted.did ? (await sorted.did.text()).trim() : "";
  const named = sorted.did ? didFromText(didText) : null;
  if (sorted.did && !named) {
    return { problem: "This did.txt does not hold one did:key value and nothing else. Nothing was unlocked." };
  }
  // a passphrase.txt only fills in for the field, and never overrides what was typed
  const passphrase = typed || passphraseFromText(sorted.passphrase ? await sorted.passphrase.text() : "");
  if (!passphrase) return { problem: "Enter the passphrase that protects this file." };
  try {
    // the DID always comes from the key in the file, whichever format it is
    if (/-----BEGIN/.test(keyText)) {
      return { identity: await openIdentityPem(subtle, keyText, passphrase, sorted.did ? didText : undefined), pem: keyText };
    }
    const identity = await openBackup(subtle, keyText, passphrase);
    if (named && named !== identity.did) {
      return { problem: "This did.txt names a different DID than the recovery file. Nothing was unlocked." };
    }
    return { identity, pem: null };
  } catch (err) {
    return { problem: err instanceof WalletError || err instanceof PemError ? err.message : "This file could not be opened." };
  }
}
