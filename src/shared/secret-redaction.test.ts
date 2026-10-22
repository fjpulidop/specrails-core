import { describe, expect, it } from 'vitest'

import { isSecretName, REDACTED, redactSecrets, redactSecretsDeep } from './secret-redaction.js'

const GHP = 'ghp_' + 'A1b2C3d4E5'.repeat(4)

describe('isSecretName', () => {
  it.each([
    'token', 'GITHUB_TOKEN', 'accessToken', 'x-auth-token', 'secret', 'CLIENT_SECRET', 'password', 'DB_PASSWD', 'passphrase',
    'api_key', 'apiKey', 'API-KEY', 'OPENAI_API_KEY', 'aws_access_key_id', 'private_key', 'privateKey', 'credentials',
    'auth', 'AUTH', 'basic_auth', 'Authorization', 'proxy-authorization', 'bearer', 'cookie', 'Set-Cookie',
    'session_token', 'sessionSecret', 'SESSION_KEY', 'session_cookie',
  ])('treats %s as secret', (name) => expect(isSecretName(name)).toBe(true))

  it.each([
    'author', 'authority', 'authenticate', 'authored_by', 'max_tokens', 'input_tokens', 'tokens', 'tokenizer',
    'session', 'sessionId', 'session_id', 'providerSessionRef', 'PATH', 'PWD', 'HOME', 'key', 'monkey', 'description',
  ])('keeps %s readable', (name) => expect(isSecretName(name)).toBe(false))
})

describe('redactSecrets', () => {
  it.each([
    ['shell export', `export GITHUB_TOKEN=${GHP}`, 'export GITHUB_TOKEN=[REDACTED]'],
    ['quoted assignment', 'export API_KEY="abc123def"; echo ok', 'export API_KEY="[REDACTED]"; echo ok'],
    ['single-quoted assignment', "DB_PASSWORD='p@ss w0rd' ./run", "DB_PASSWORD='[REDACTED]' ./run"],
    ['.env line', 'STRIPE_SECRET_KEY=whsec_123\nPORT=3000', 'STRIPE_SECRET_KEY=[REDACTED]\nPORT=3000'],
    ['yaml', 'password: hunter2\nuser: admin', 'password: [REDACTED]\nuser: admin'],
    ['json', '{"access_token": "abc", "sessionId": "s1"}', '{"access_token": "[REDACTED]", "sessionId": "s1"}'],
    ['dotted name', 'process.env.NPM_TOKEN=abc', 'process.env.NPM_TOKEN=[REDACTED]'],
    ['authorization bearer', 'curl -H "Authorization: Bearer abc.def.ghi" https://x', 'curl -H "Authorization: Bearer [REDACTED]" https://x'],
    ['authorization basic', 'Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [REDACTED]'],
    ['authorization without scheme', 'authorization=abc123', 'authorization=[REDACTED]'],
    ['standalone bearer', 'sent Bearer abcdefghijklmnop1234 upstream', 'sent Bearer [REDACTED] upstream'],
    ['--token value', 'gh auth login --token abc123 --hostname x', 'gh auth login --token [REDACTED] --hostname x'],
    ['--api-key=value', 'cli --api-key=xyz789 --verbose', 'cli --api-key=[REDACTED] --verbose'],
    ['--password "value"', 'tool --password "a b c" next', 'tool --password "[REDACTED]" next'],
    ['--github-token', 'run --github-token t0k3n', 'run --github-token [REDACTED]'],
    ['url credentials', 'postgres://user:pa55@db:5432/x', 'postgres://user:[REDACTED]@db:5432/x'],
    ['openai key', 'key sk-proj-abcdefghij1234567890KLMNOP done', 'key [REDACTED] done'],
    ['anthropic key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', '[REDACTED]'],
    ['github classic', `use ${GHP}`, 'use [REDACTED]'],
    ['github fine-grained', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', '[REDACTED]'],
    ['slack', 'xoxb-1234567890-abcdefghij and xoxp-0987654321-zyxwvutsrq', '[REDACTED] and [REDACTED]'],
    ['aws', 'id AKIAABCDEFGHIJKLMNOP end', 'id [REDACTED] end'],
    ['google', 'k=AIzaSyA-1234567890abcdefghijklmnopqrstu;', 'k=[REDACTED];'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', '[REDACTED]'],
    ['pem block', 'a\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef==\n-----END RSA PRIVATE KEY-----\nafter', 'a\n[REDACTED]\nafter'],
    ['truncated pem', 'x -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA', 'x [REDACTED]'],
  ])('redacts %s', (_name, input, expected) => expect(redactSecrets(input)).toBe(expected))

  it('redacts several secrets in one string', () => {
    const input = `TOKEN=a1 PASSWORD=b2 curl -H 'Authorization: Bearer c3' --api-key d4 ${GHP} AKIAABCDEFGHIJKLMNOP`
    const output = redactSecrets(input)
    for (const secret of ['a1', 'b2', 'c3', 'd4', GHP, 'AKIAABCDEFGHIJKLMNOP']) expect(output).not.toContain(secret)
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(6)
  })

  it.each([
    'The author has authority over authentication.',
    'max_tokens: 4096; tokenizer: cl100k; input_tokens=12',
    'const token: string = readToken()',
    'auth: true, secret: null',
    'TOKEN=$GITHUB_TOKEN ./deploy',
    'Bearer authentication is described in RFC 6750',
    'see https://example.com/docs?page=2 and risk-assessment-for-something-12345',
    'docker login --password-stdin -u me',
    'sessionId=abc-123 session=open',
    'key = 42',
    '',
  ])('leaves ordinary text alone: %j', (text) => expect(redactSecrets(text)).toBe(text))

  it('is idempotent and closes a value glued to an earlier redaction', () => {
    const once = redactSecrets(`export TOKEN=${GHP}; Authorization: Bearer abc; -----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----`)
    expect(redactSecrets(once)).toBe(once)
    expect(redactSecrets('TOKEN=[REDACTED]cdef')).toBe('TOKEN=[REDACTED]')
  })

  it('is deterministic', () => {
    const input = `PASSWORD=x ${GHP}`
    expect(redactSecrets(input)).toBe(redactSecrets(input))
  })

  it.each([
    ['plain', 'a'.repeat(1 << 20)],
    ['assignments', 'a=b '.repeat(1 << 18)],
    ['secret assignments', 'token=x '.repeat(1 << 17)],
    ['unterminated quotes', 'token="'.repeat(150_000)],
    ['flags', '--token '.repeat(131_072)],
    ['pem markers without end', '-----BEGIN PRIVATE KEY-----'.repeat(40_000)],
    ['key prefixes', 'sk-'.repeat(350_000)],
    ['bearer words', 'bearer '.repeat(150_000)],
    ['prose', 'lorem ipsum dolor sit amet, '.repeat(37_500)],
  ])('stays linear on a 1 MB %s input', (_name, input) => {
    const started = performance.now()
    redactSecrets(input)
    expect(performance.now() - started).toBeLessThan(3_000)
  })
})

describe('redactSecretsDeep', () => {
  it('redacts secret-named keys at any depth and scans every other string', () => {
    const input = {
      command: 'export SECRET=1 && run',
      env: { GITHUB_TOKEN: GHP, PATH: '/bin', max_tokens: 5 },
      headers: [{ name: 'x', Authorization: 'Bearer abc' }],
      credentials: { user: 'admin', pass: 'p', retries: 3 },
      nested: { deeper: [[{ apiKey: 'k1' }, 'Bearer abcdefghijklmnop1234']] },
      flags: { auth: true, token: null, count: 2 },
    }
    expect(redactSecretsDeep(input)).toEqual({
      command: 'export SECRET=[REDACTED] && run',
      env: { GITHUB_TOKEN: REDACTED, PATH: '/bin', max_tokens: 5 },
      headers: [{ name: 'x', Authorization: REDACTED }],
      credentials: { user: REDACTED, pass: REDACTED, retries: 3 },
      nested: { deeper: [[{ apiKey: REDACTED }, 'Bearer [REDACTED]']] },
      flags: { auth: true, token: null, count: 2 },
    })
    expect(input.env.GITHUB_TOKEN).toBe(GHP)
  })

  it('passes primitives through', () => {
    expect(redactSecretsDeep(7)).toBe(7)
    expect(redactSecretsDeep(null)).toBe(null)
    expect(redactSecretsDeep(undefined)).toBe(undefined)
    expect(redactSecretsDeep(`x ${GHP}`)).toBe('x [REDACTED]')
  })

  it('bounds recursion depth', () => {
    let deep: unknown = { token: 'leaf' }
    for (let index = 0; index < 100; index++) deep = { next: deep }
    expect(() => redactSecretsDeep(deep)).not.toThrow()
  })
})
