export function computerProviderUnavailableMessage(platform: NodeJS.Platform): string {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return `computer-use has no native provider for ${platform} in this build`
  }
  return `computer-use has no native provider for ${platform}`
}
