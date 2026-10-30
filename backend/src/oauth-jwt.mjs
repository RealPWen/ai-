import { createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { ResearchError } from './errors.mjs';

const ISSUER = 'https://auth.openai.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const fail = () => new ResearchError('CHATGPT_IDENTITY_INVALID', 'ChatGPT 身份验证失败，请重新登录', 401);

export function secureEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Accept only OpenAI's published RS256 key set; never follow a JWT's jku/x5u URL.
export function createIDTokenVerifier({ fetchJSON, now }) {
  let keys; let loadedAt = 0;
  async function getKeys(force = false) {
    if (force || !keys || now().getTime() - loadedAt > 3600000) {
      const document = await fetchJSON(JWKS_URL);
      if (!Array.isArray(document?.keys)) throw fail();
      keys = document.keys; loadedAt = now().getTime();
    }
    return keys;
  }
  return async function verifyIDToken(token, { clientId, nonce, subject }) {
    try {
      if (typeof token !== 'string' || token.length > 65536) throw fail();
      const pieces = token.split('.');
      if (pieces.length !== 3 || pieces.some(value => !/^[A-Za-z0-9_-]+$/.test(value))) throw fail();
      const header = JSON.parse(Buffer.from(pieces[0], 'base64url'));
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) throw fail();
      let jwk = (await getKeys()).find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
      if (!jwk) jwk = (await getKeys(true)).find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
      if (!jwk || (jwk.key_ops && !jwk.key_ops.includes('verify'))) throw fail();
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      if (!verify('RSA-SHA256', Buffer.from(`${pieces[0]}.${pieces[1]}`), key, Buffer.from(pieces[2], 'base64url'))) throw fail();
      const claims = JSON.parse(Buffer.from(pieces[1], 'base64url'));
      const seconds = Math.floor(now().getTime() / 1000);
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId)) throw fail();
      if (!Number.isFinite(claims.exp) || claims.exp <= seconds || !Number.isFinite(claims.iat) || claims.iat > seconds + 60 || claims.iat > claims.exp) throw fail();
      if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 60)) throw fail();
      if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512) throw fail();
      if (nonce !== undefined && !secureEqual(claims.nonce, nonce)) throw fail();
      if (subject !== undefined && !secureEqual(claims.sub, subject)) throw fail();
      return claims;
    } catch (error) {
      if (error instanceof ResearchError && error.code !== 'CHATGPT_IDENTITY_INVALID') throw error;
      throw fail();
    }
  };
}
