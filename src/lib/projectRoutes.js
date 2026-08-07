const WORKSPACE_SHORTCUT_REDIRECTS = Object.freeze({
  overview: '/overview',
  'run-suite': '/run-suite',
  tests: '/test-cases',
  live: '/live-pipeline',
  results: '/reports',
  'output-files': '/output-files',
  recovery: '/blocked-items',
  memory: '/knowledge-base',
});

export function getWorkspaceShortcutRedirect(pathname) {
  if (!pathname || typeof pathname !== 'string') return null;
  const cleanPath = pathname.split(/[?#]/)[0];
  const segments = cleanPath.split('/').filter(Boolean);
  if (segments[0] !== 'projects') return null;
  return WORKSPACE_SHORTCUT_REDIRECTS[segments[1]] || null;
}

export function buildProjectWorkspacePath(projectId, tab) {
  if (projectId) return `/projects/${projectId}/${tab}`;
  return WORKSPACE_SHORTCUT_REDIRECTS[tab] || '/project-setup';
}
