/**
 * Files and folders the knowledge index never reads, whatever a collection's
 * exclude list says: credential stores, private keys, and environment files.
 * Search results reach the model and its session log, so a secret indexed
 * once would be one query away from both.
 * @module
 */

/** Folder names, compared lowercase, that hold credentials or keys. */
export const SECRET_DIRS: ReadonlySet<string> = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.password-store'])

/** File names, compared lowercase, that hold credentials. */
const SECRET_FILES: ReadonlySet<string> = new Set(['.netrc', '_netrc', '.pgpass', '.npmrc', '.pypirc', '.git-credentials'])

/** Extensions of key and certificate stores. */
const SECRET_EXTENSIONS: ReadonlySet<string> = new Set(['pem', 'key', 'p12', 'pfx', 'kdbx', 'ppk', 'jks', 'keystore'])

/** Private key names the SSH tools write; a longer name such as `id_rsa_work` is a key too. */
const PRIVATE_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)/u

/**
 * Whether a file name marks a secret: an environment file (`.env`, `.env.*`,
 * `*.env`), an SSH private key, a key or certificate store, a known
 * credential file, or any name containing `credentials` or `secret`.
 * @param name - the file's base name.
 * @returns `true` when the index must not read the file.
 */
export function isSecretFile(name: string): boolean {
  const base = name.toLowerCase()
  if (base.startsWith('.env.') || base.endsWith('.env')) return true
  if (SECRET_FILES.has(base) || PRIVATE_KEY.test(base)) return true
  if (base.includes('credentials') || base.includes('secret')) return true
  const dot = base.lastIndexOf('.')
  return dot > 0 && SECRET_EXTENSIONS.has(base.slice(dot + 1))
}
