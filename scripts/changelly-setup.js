import 'dotenv/config';
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
let hex = process.env.CHANGELLY_PRIVATE_KEY_HEX;
if (!hex) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  hex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
  const original = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
  const entry = 'CHANGELLY_PRIVATE_KEY_HEX=' + hex;
  fs.writeFileSync('.env', /^CHANGELLY_PRIVATE_KEY_HEX=.*$/m.test(original) ? original.replace(/^CHANGELLY_PRIVATE_KEY_HEX=.*$/m, () => entry) : original + '\n' + entry + '\n');
}
const privateKey = createPrivateKey({ key: Buffer.from(hex, 'hex'), type: 'pkcs8', format: 'der' });
const publicDer = createPublicKey(privateKey).export({ type: 'pkcs1', format: 'der' });
fs.mkdirSync('exports', { recursive: true });
fs.writeFileSync('exports/changelly-registration.txt', [
  'To: pro@changelly.com',
  'Subject: Exchange API v2 activation and zero partner extra fee',
  '',
  'Please activate Exchange API v2 for our Discord swap bot, https://github.com/moonn-js/swap.',
  'Changelly will be a fallback when NEAR Intents 1Click has no route, including LTC to USDT on BNB Smart Chain and Solana.',
  'Account email: [enter the email registered on Changelly]',
  'Please configure our partner API extra fee to 0% and confirm your service and network fees.',
  '',
  'Public API key (SHA256, Base64): ' + createHash('sha256').update(publicDer).digest('base64'),
  'Public key (PKCS#1 DER, Base64): ' + publicDer.toString('base64'),
].join('\n'));
process.stdout.write('Private key saved in ignored .env. Public registration draft: exports/changelly-registration.txt\n');
