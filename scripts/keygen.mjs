// Generates the key pair that pins Facet's extension ID.
//
//   node scripts/keygen.mjs          create keys/facet.pem + extension-key.pub (refuses to overwrite)
//   node scripts/keygen.mjs --force  replace an existing key pair (changes the extension ID!)
//   node scripts/keygen.mjs --id     print the ID of the committed public key
//
// keys/ is gitignored: the private key never enters the repo. extension-key.pub holds the
// base64 SPKI public key that wxt.config.ts puts into the manifest `key` field.
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const privatePath = join(root, 'keys', 'facet.pem');
const publicPath = join(root, 'extension-key.pub');

/** Chrome derives the ID from the first 16 bytes of SHA-256(SPKI DER), hex digits mapped 0-f -> a-p. */
function extensionId(spkiDer) {
  const hex = createHash('sha256').update(spkiDer).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

const args = new Set(process.argv.slice(2));

if (args.has('--id')) {
  const der = Buffer.from(readFileSync(publicPath, 'utf8').trim(), 'base64');
  console.log(extensionId(der));
  process.exit(0);
}

if (!args.has('--force') && (existsSync(privatePath) || existsSync(publicPath))) {
  console.error('A key pair already exists. Re-run with --force to replace it (this changes the extension ID).');
  process.exit(1);
}

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const spkiDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });

mkdirSync(dirname(privatePath), { recursive: true });
writeFileSync(privatePath, privatePem, { mode: 0o600 });
writeFileSync(publicPath, `${spkiDer.toString('base64')}\n`);

console.log(`private key: ${privatePath} (keep it out of git)`);
console.log(`public key:  ${publicPath}`);
console.log(`extension ID: ${extensionId(spkiDer)}`);
