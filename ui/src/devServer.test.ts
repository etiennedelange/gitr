import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import config from '../vite.config'

const devUrl = (file: string) => JSON.parse(readFileSync(resolve(__dirname, '../../src-tauri', file), 'utf8')).build.devUrl as string

describe('dev server address', () => {
  // With `localhost` Vite may listen on [::1] only; VS Code's port forwarding connects to
  // 127.0.0.1 and the page hangs while loading.
  it('listens on IPv4 loopback, where Tauri and port forwarding look for it', () => {
    expect(config.server?.host).toBe('127.0.0.1')
    expect(devUrl('tauri.conf.json')).toBe(`http://127.0.0.1:${config.server?.port}`)
    expect(devUrl('tauri.mock.conf.json')).toBe(`http://127.0.0.1:${config.server?.port}/preview.html`)
  })
})
