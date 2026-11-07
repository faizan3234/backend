import crypto from 'crypto';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1'
});

const publicJwk = publicKey.export({ format: 'jwk' });
const privateJwk = privateKey.export({ format: 'jwk' });

const x = Buffer.from(publicJwk.x, 'base64url');
const y = Buffer.from(publicJwk.y, 'base64url');
const uncompressedPublic = Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url');

console.log('VAPID_PUBLIC_KEY=' + uncompressedPublic);
console.log('VAPID_PRIVATE_KEY=' + privateJwk.d);
