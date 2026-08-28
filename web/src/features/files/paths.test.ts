import { describe, expect, it } from 'vitest'
import { baseName, crumbsFor, joinPath, parentPath } from './paths'

describe('device paths', () => {
  it('joins with the separator the directory uses', () => {
    expect(joinPath('/home/u', 'a.txt')).toBe('/home/u/a.txt')
    expect(joinPath('/', 'usr')).toBe('/usr')
    expect(joinPath('C:\\Users', 'x')).toBe('C:\\Users\\x')
    expect(joinPath('C:\\', 'x')).toBe('C:\\x')
    expect(joinPath('', 'x')).toBe('x')
  })

  it('walks up to the root and then to the well-known roots', () => {
    expect(parentPath('/home/u/docs')).toBe('/home/u')
    expect(parentPath('/home')).toBe('/')
    expect(parentPath('/')).toBeNull()
    expect(parentPath('C:\\Users\\x')).toBe('C:\\Users')
    expect(parentPath('C:\\Users')).toBe('C:\\')
    expect(parentPath('C:\\')).toBeNull()
  })

  it('builds crumbs and base names', () => {
    expect(crumbsFor('/home/u')).toEqual([
      { label: 'home', path: '/home' },
      { label: 'u', path: '/home/u' },
    ])
    expect(crumbsFor('C:\\Users\\x').map((c) => c.path)).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\x'])
    expect(crumbsFor('')).toEqual([])
    expect(baseName('C:\\Users\\x\\f.txt')).toBe('f.txt')
    expect(baseName('/a/b')).toBe('b')
  })
})
