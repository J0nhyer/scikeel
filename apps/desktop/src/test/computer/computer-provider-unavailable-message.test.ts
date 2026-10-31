// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { computerProviderUnavailableMessage } from '../../../../../runtime/computer/computer-provider-unavailable-message'

describe('computerProviderUnavailableMessage', () => {
  it('names the missing macOS provider without pointing at a deleted script', () => {
    expect(computerProviderUnavailableMessage('darwin')).toBe(
      'computer-use has no native provider for darwin in this build'
    )
  })

  it('names the missing Linux and Windows providers', () => {
    expect(computerProviderUnavailableMessage('linux')).toBe(
      'computer-use has no native provider for linux in this build'
    )
    expect(computerProviderUnavailableMessage('win32')).toBe(
      'computer-use has no native provider for win32 in this build'
    )
  })

  it('keeps unsupported platforms explicit', () => {
    expect(computerProviderUnavailableMessage('freebsd')).toBe(
      'computer-use has no native provider for freebsd'
    )
  })
})
