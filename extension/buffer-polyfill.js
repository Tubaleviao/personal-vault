// Minimal Buffer polyfill for the extension bundle.
// bip39 uses Buffer as a Node.js global; Chrome extension contexts don't have it.
// esbuild's inject option makes this export available wherever Buffer is a free reference.
//
// Covers exactly what bip39 needs:
//   Buffer.from(string, 'utf8' | 'hex')
//   Buffer.from(Uint8Array | Array<number>)
//   Buffer.isBuffer(x)
//   instance.toString('hex')
//   instance.buffer / .byteOffset / .byteLength / .length  (inherited from Uint8Array)

class BrowserBuffer extends Uint8Array {
  static from(value, encoding) {
    if (typeof value === 'string') {
      if (encoding === 'hex') {
        const out = new BrowserBuffer(value.length >>> 1)
        for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16)
        return out
      }
      const bytes = new TextEncoder().encode(value)
      const out = new BrowserBuffer(bytes.length)
      out.set(bytes)
      return out
    }
    if (value instanceof ArrayBuffer) {
      const out = new BrowserBuffer(value.byteLength)
      out.set(new Uint8Array(value))
      return out
    }
    if (ArrayBuffer.isView(value)) {
      const src = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      const out = new BrowserBuffer(src.length)
      out.set(src)
      return out
    }
    if (Array.isArray(value)) {
      const out = new BrowserBuffer(value.length)
      for (let i = 0; i < value.length; i++) out[i] = value[i] & 0xff
      return out
    }
    return new BrowserBuffer(0)
  }

  static isBuffer(obj) { return obj instanceof BrowserBuffer }

  static alloc(size, fill) {
    const buf = new BrowserBuffer(size)
    if (fill !== undefined) buf.fill(fill)
    return buf
  }

  static concat(list, totalLength) {
    const len = totalLength ?? list.reduce((acc, b) => acc + b.length, 0)
    const out = new BrowserBuffer(len)
    let offset = 0
    for (const b of list) { out.set(b, offset); offset += b.length }
    return out
  }

  toString(encoding) {
    const bytes = new Uint8Array(this.buffer, this.byteOffset, this.byteLength)
    if (encoding === 'hex') return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
    if (encoding === 'base64') return btoa(String.fromCharCode(...bytes))
    return new TextDecoder().decode(bytes)
  }
}

export { BrowserBuffer as Buffer }
