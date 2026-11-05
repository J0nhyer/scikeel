const leafGroups = new Map([
  ['apps/desktop/src/components/thread/WorkflowStarters.tsx', ['src/components/thread/WorkflowStarters.test.tsx']],
]);
const docs = (path) => /^(?:docs\/|(?:README|PROGRESS|AGENTS|CLAUDE|SKILL)\.md$|scripts\/README\.md$)/.test(path);
const outsideWeb = (path) => /^(?:\.github\/|crates\/|native\/|apps\/desktop\/src-tauri\/|Cargo\.(?:toml|lock)$)/.test(path);
const broad = (path) => /(?:pnpm-lock|package\.json|vite\.config|tsconfig|eslint|tailwind|postcss|\.github\/)/.test(path);

export function selectVerification(paths, baseline, { full = false } = {}) {
  const source = paths.filter((path) => !docs(path) && !outsideWeb(path) && !path.startsWith('scripts/dev/web-release'));
  const result = { full: false, frontendFull: false, platformFull: false, frontendFiles: [], platformFiles: [],
    buildWeb: false, deployPlatform: false, deploy: source.length > 0, reasons: [] };
  if (!source.length && baseline.known && !full) return result;

  const frontend = new Set();
  for (const path of source) {
    if (path.startsWith('apps/desktop/src/')) {
      result.buildWeb = true;
      if (leafGroups.has(path)) leafGroups.get(path).forEach((file) => frontend.add(file));
      else if (path.startsWith('apps/desktop/src/i18n/locales/')) {
        ['src/i18n/parity.test.ts', 'src/i18n/config.test.ts', 'src/i18n/index.test.ts'].forEach((file) => frontend.add(file));
      } else result.frontendFull = true;
    } else if (path.startsWith('services/platform/test/')) {
      result.platformFiles.push(path.slice('services/platform/'.length));
      result.deployPlatform = true;
    } else if (path.startsWith('services/platform/src/')) {
      result.platformFull = true;
      result.deployPlatform = true;
      if (/platform-server|login-page|auth-store/.test(path)) result.buildWeb = true;
    } else if (path.startsWith('runtime/')) {
      result.platformFull = true;
      result.deployPlatform = true;
    } else if (path.startsWith('packages/')) {
      result.frontendFull = result.platformFull = result.buildWeb = true;
    } else {
      result.frontendFull = result.platformFull = result.buildWeb = true;
    }
    if (broad(path)) result.frontendFull = result.platformFull = result.buildWeb = true;
  }

  if (!baseline.known || full) {
    result.full = result.frontendFull = result.platformFull = result.buildWeb = true;
    result.deploy = true;
    result.deployPlatform ||= !baseline.known;
  } else result.full = result.frontendFull && result.platformFull;

  result.frontendFiles = [...frontend].sort();
  result.platformFiles = [...new Set(result.platformFiles)].sort();
  return result;
}
