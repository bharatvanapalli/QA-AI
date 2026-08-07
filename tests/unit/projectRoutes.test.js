import { describe, expect, it } from 'vitest';
import { buildProjectWorkspacePath, getWorkspaceShortcutRedirect } from '../../src/lib/projectRoutes';

describe('project route helpers', () => {
  it('redirects reserved workspace tabs that were mistaken for project ids', () => {
    expect(getWorkspaceShortcutRedirect('/projects/results')).toBe('/reports');
    expect(getWorkspaceShortcutRedirect('/projects/results/overview')).toBe('/reports');
    expect(getWorkspaceShortcutRedirect('/projects/tests/overview')).toBe('/test-cases');
  });

  it('does not redirect real project ids', () => {
    expect(getWorkspaceShortcutRedirect('/projects/6a68412b-2d91-4ec5-b15a-2e1bf8fd744e/results')).toBeNull();
  });

  it('builds safe fallback links while the active project is still loading', () => {
    expect(buildProjectWorkspacePath(null, 'results')).toBe('/reports');
    expect(buildProjectWorkspacePath(undefined, 'overview')).toBe('/overview');
    expect(buildProjectWorkspacePath('project-1', 'results')).toBe('/projects/project-1/results');
  });
});
