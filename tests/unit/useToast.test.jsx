import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast } from '../../src/lib/useToast';

// Tiny harness that exposes the toast API onto a button so we can drive
// push/dismiss from a real DOM click — closer to how callers actually use
// the hook than calling it from a test-only render call.
function Harness({ onMount }) {
  const t = useToast();
  React.useEffect(() => { onMount?.(t); }, [onMount, t]);
  return (
    <div>
      <button onClick={() => t.success('all good', { title: 'Success' })}>push-ok</button>
      <button onClick={() => t.error('it broke')}>push-err</button>
    </div>
  );
}

describe('useToast', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders the live region wrapper with the right ARIA semantics', () => {
    render(<ToastProvider><div /></ToastProvider>);
    const region = screen.getByRole('region', { name: /notifications/i });
    expect(region).toBeInTheDocument();
  });

  it('announces success toasts with role="status" + polite live region', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ToastProvider><Harness /></ToastProvider>);
    await user.click(screen.getByText('push-ok'));
    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent(/all good/i);
    expect(toast).toHaveAttribute('aria-live', 'polite');
    expect(toast).toHaveAttribute('aria-atomic', 'true');
  });

  it('escalates error toasts to role="alert" + assertive', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ToastProvider><Harness /></ToastProvider>);
    await user.click(screen.getByText('push-err'));
    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent(/it broke/i);
    expect(toast).toHaveAttribute('aria-live', 'assertive');
  });

  it('auto-dismisses non-error toasts after the default ttl', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ToastProvider><Harness /></ToastProvider>);
    await user.click(screen.getByText('push-ok'));
    expect(screen.getByText('all good')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(4500); });
    expect(screen.queryByText('all good')).not.toBeInTheDocument();
  });

  it('keeps error toasts up longer (8s) than success (4s)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ToastProvider><Harness /></ToastProvider>);
    await user.click(screen.getByText('push-err'));
    act(() => { vi.advanceTimersByTime(5000); });
    // Still there past 4s
    expect(screen.queryByText('it broke')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByText('it broke')).not.toBeInTheDocument();
  });

  it('lets the user dismiss via the keyboard-reachable button', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ToastProvider><Harness /></ToastProvider>);
    await user.click(screen.getByText('push-ok'));
    const dismiss = screen.getByRole('button', { name: /dismiss notification/i });
    expect(dismiss).toBeInTheDocument();
    await user.click(dismiss);
    expect(screen.queryByText('all good')).not.toBeInTheDocument();
  });

  it('exposes a programmatic dismiss(id) on the context', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let apiHandle;
    render(
      <ToastProvider>
        <Harness onMount={(t) => { apiHandle = t; }} />
      </ToastProvider>
    );
    await user.click(screen.getByText('push-ok'));
    const id = apiHandle.success('ephemeral');
    act(() => { apiHandle.dismiss(id); });
    expect(screen.queryByText('ephemeral')).not.toBeInTheDocument();
  });
});
