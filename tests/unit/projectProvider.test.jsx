import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { ProjectProvider, useProject, __test__ as projectInternals } from '../../src/store/project';
import { ToastProvider } from '../../src/lib/useToast';
import * as authStore from '../../src/store/auth';
import api from '../../src/lib/apiClient';

// Tiny consumer that prints the relevant pieces of context state so tests
// can assert against the DOM rather than poking at internals.
function Consumer() {
  const { current, projects, loading } = useProject();
  if (loading) return <div data-testid="state">loading</div>;
  return (
    <div data-testid="state">
      <div data-testid="current">{current?.name || 'none'}</div>
      <div data-testid="count">{projects.length}</div>
    </div>
  );
}

function renderWithProviders() {
  return render(
    <ToastProvider>
      <ProjectProvider>
        <Consumer />
      </ProjectProvider>
    </ToastProvider>
  );
}

describe('ProjectProvider', () => {
  let getSpy;
  let useAuthSpy;
  beforeEach(() => {
    // Pretend the user is authed so load() actually runs.
    useAuthSpy = vi.spyOn(authStore, 'useAuth').mockReturnValue({ status: 'authed' });
    getSpy = vi.spyOn(api, 'get');
    // Default to an empty localStorage. Each test mutates as needed.
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects the first project when nothing is persisted', async () => {
    getSpy.mockResolvedValueOnce({ projects: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] });
    renderWithProviders();
    await waitFor(() => expect(screen.getByTestId('current')).toHaveTextContent('Alpha'));
    expect(window.localStorage.getItem(projectInternals.LS_KEY)).toBe('a');
  });

  it('restores the saved project id from localStorage', async () => {
    window.localStorage.setItem(projectInternals.LS_KEY, 'b');
    getSpy.mockResolvedValueOnce({ projects: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] });
    renderWithProviders();
    await waitFor(() => expect(screen.getByTestId('current')).toHaveTextContent('Beta'));
  });

  it('falls back to in-memory store when localStorage throws', async () => {
    // Simulate Safari private mode: every getItem/setItem throws.
    const origGet = Storage.prototype.getItem;
    const origSet = Storage.prototype.setItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
    try {
      getSpy.mockResolvedValueOnce({ projects: [{ id: 'a', name: 'Alpha' }] });
      renderWithProviders();
      // The provider should not crash, and should still pick the first project.
      await waitFor(() => expect(screen.getByTestId('current')).toHaveTextContent('Alpha'));
    } finally {
      Storage.prototype.getItem = origGet;
      Storage.prototype.setItem = origSet;
    }
  });

  it('renders the loading state until projects resolve', async () => {
    let resolveFetch;
    getSpy.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));
    renderWithProviders();
    expect(screen.getByTestId('state')).toHaveTextContent('loading');
    act(() => resolveFetch({ projects: [{ id: 'a', name: 'Alpha' }] }));
    await waitFor(() => expect(screen.getByTestId('current')).toHaveTextContent('Alpha'));
  });

  it('does not call /projects while auth is still checking', async () => {
    useAuthSpy.mockReturnValue({ status: 'checking' });
    renderWithProviders();
    // The fetch should not be issued — `load()` early-returns when not authed.
    expect(getSpy).not.toHaveBeenCalled();
  });
});
