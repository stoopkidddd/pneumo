export function passphraseError(passphrase: string, repeated: string): string | null {
  const normalized = passphrase.normalize("NFC");
  if (Array.from(normalized).length < 12) return "Use a passphrase with at least 12 characters.";
  if (normalized !== repeated.normalize("NFC"))
    return "The passphrases do not match. Enter them again.";
  return null;
}
