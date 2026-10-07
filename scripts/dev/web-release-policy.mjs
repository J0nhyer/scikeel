const leafGroups = new Map([
  ['apps/desktop/src/components/thread/WorkflowStarters.tsx', ['src/components/thread/WorkflowStarters.test.tsx']],
]);
const docs = (path) => /^(?:docs\/|(?:README|PROGRESS|AGENTS|CLAUDE)\.md$|scripts\/README\.md$)/.test(path);
const broad = (path) => /(?:pnpm-lock|package\.json|vite\.config|tsconfig|eslint|tailwind|postcss|scripts\/|\.github\/|Cargo\.(?:toml|lock))/.test(path);
const workflow = (path) => /^(?:scripts\/dev\/(?:web-release|web-build|web-vendor|build-web-vendor|safe-desktop-task)|package\.json$|apps\/desktop\/(?:package\.json|vite\.config|web-vendor)|pnpm-lock\.yaml$)/.test(path);
export const imageInputPath = (path) => /^(?:runtime\/(?:sandbox|skills\/core|opencode-patches)\/|crates\/|scripts\/dev\/(?:prepare-science-image|stage-sandbox-image|fetch-sandbox-codex|fetch-opencode|fetch-uv|build-opencode-title-runtime)|\.github\/workflows\/sandbox-image|(?:packages\/sdk\/src\/tool-outcome\.(?:mjs|d\.mts)|Cargo\.(?:toml|lock)|OPENCODE_VERSION)$)/.test(path);
const interactions = (path) => /^(?:services\/platform\/src\/(?:session-authority|interaction-replies|tenant-policy|platform-server|collaboration|research-tasks|managed-worker-manager)|apps\/desktop\/src\/(?:lib\/(?:runtime|interactionState)|components\/(?:thread\/(?:InteractionPrompt|ResearchTaskPanel)|session\/SessionView))|packages\/sdk\/src\/(?:OpenCodeClient|runtime|types))/.test(path);
const toolReliability = (path) => /^(?:apps\/desktop\/src\/components\/thread\/Tool(?:CallRow|Group)|runtime\/(?:opencode-patches\/(?:managed-network|network)|sandbox\/(?:runner|collaboration|tool-outcome))|services\/platform\/src\/(?:network-operations|tool-outcomes|collaboration|egress-broker|model-broker|tenant-policy|platform-server)|packages\/sdk\/src\/(?:tool-outcome|OpenCodeClient)|packages\/shared\/src\/toolOutcome)/.test(path);
const live = (path) => /^(?:runtime\/|crates\/)|^services\/platform\/src\/(?:model-broker|tenant-policy|sandbox-|managed-worker|cli-runtime|cli-profile|attachment-turns)/.test(path);
export function selectVerification(paths, baseline, { full = false } = {}) {
  const source = paths.filter((path) => !docs(path));
  if (!source.length && (full || (!baseline.known && !paths.length))) source.push('__bootstrap__');
  const result = { full: false, frontendFull: false, platformFull: false, frontendFiles: [], platformFiles: [],
    browserGroups: [], typecheck: false, lint: false, buildWeb: false, deployPlatform: false, deploy: source.length > 0,
    rustPackages: [...new Set(source.map((path) => /^crates\/(osd-core|osd-cli|osd-sandbox-host)\//.exec(path)?.[1]).filter(Boolean))], workflowTests: source.some(workflow) || !baseline.known || full, imageRequired: source.some(imageInputPath), liveOpenCode: source.some(live) || source.some(imageInputPath) || source.some((path) => /^(?:apps\/desktop\/src\/lib\/runtime\.ts|packages\/sdk\/src\/OpenCodeClient\.ts|services\/platform\/src\/platform-server\.mjs)$/.test(path)), reasons: [] };
  if (!source.length) { result.reasons.push('No source changes: no build or deployment'); return result; }
  const frontend = new Set(); const browser = new Set(['app']);
  for (const path of source) {
    if (interactions(path)) { result.buildWeb = result.typecheck = result.lint = true; browser.add('session'); browser.add('interactions'); }
    if (toolReliability(path)) { result.buildWeb = result.typecheck = result.lint = true; browser.add('session'); }
    if (path.startsWith('apps/desktop/')) {
      result.buildWeb = result.typecheck = result.lint = true;
      if (leafGroups.has(path)) leafGroups.get(path).forEach((file) => frontend.add(file));
      else if (path.startsWith('apps/desktop/src/i18n/locales/')) {
        ['src/i18n/parity.test.ts', 'src/i18n/config.test.ts', 'src/i18n/index.test.ts'].forEach((file) => frontend.add(file));
      } else result.frontendFull = true;
      if (/login|runtime|session|SessionView|history|webMode/i.test(path)) { browser.add('session'); result.platformFull = true; }
      if (/attach/i.test(path)) browser.add('attachments');
    } else if (path.startsWith('services/platform/')) {
      result.platformFull = true;
      if (path.startsWith('services/platform/src/')) result.deployPlatform = true;
      if (/platform-server|login-page|auth-store/.test(path)) { result.buildWeb = true; browser.add('login'); browser.add('session'); }
    } else if (path.startsWith('runtime/')) {
      result.deployPlatform = result.platformFull = true;
    } else if (path.startsWith('packages/')) {
      result.frontendFull = result.platformFull = result.buildWeb = result.typecheck = result.lint = true; browser.add('session');
    } else {
      result.frontendFull = result.platformFull = result.buildWeb = result.typecheck = result.lint = true;
    }
    if (broad(path)) result.frontendFull = result.platformFull = result.buildWeb = result.typecheck = result.lint = true;
  }
  if (!baseline.known || full) {
    result.full = result.frontendFull = result.platformFull = result.buildWeb = result.typecheck = result.lint = true;
    if (!baseline.known) result.deployPlatform = true;
    browser.add('login'); browser.add('session'); browser.add('attachments');
    result.reasons.push(full ? 'Full verification explicitly requested' : 'Incomplete deployed source baseline: full bootstrap verification');
  } else result.full = result.frontendFull && result.platformFull;
  if (result.liveOpenCode) result.platformFull = true;
  if (result.buildWeb) result.typecheck = result.lint = true;
  result.frontendFiles = [...frontend].sort(); result.browserGroups = result.buildWeb ? [...browser].sort() : [];
  if (!result.platformFull) result.reasons.push('No affected platform suite');
  if (!result.liveOpenCode) result.reasons.push('No model/runtime changes: no real provider calls');
  if (!result.imageRequired) result.reasons.push('No scientific image inputs changed: reuse installed image');
  return result;
}
