// Unambiguous when read aloud or retyped: no 0/O, 1/l/I, 5/S, 2/Z.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRTUVWXY346789'

/**
 * A password an admin hands to someone: four groups of four (`k7Fq-9xTm-…`, ~90 bits), easy to
 * read out and retype, never starting or ending with whitespace.
 */
export function generatePassword(groups = 4, size = 4): string {
  const bytes = new Uint32Array(groups * size)
  crypto.getRandomValues(bytes)
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length])
  const out: string[] = []
  for (let g = 0; g < groups; g++) out.push(chars.slice(g * size, (g + 1) * size).join(''))
  return out.join('-')
}

/** What to send someone so they can sign in: the console address, their email, the password. */
export function signInDetails(email: string, password: string, origin = window.location.origin): string {
  return `Console: ${origin}\nEmail: ${email}\nPassword: ${password}`
}
