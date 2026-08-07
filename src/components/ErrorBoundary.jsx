import React from 'react';

// Catches React render-phase errors and shows a fallback. The class form
// is required — hooks can't catch errors. Pass a `resetKey` prop to make
// the boundary forget a captured error when the key changes; the common
// case is passing the current pathname so navigating to a different page
// clears the "Something broke" state instead of stranding the user.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err };
  }
  componentDidCatch(err, info) {
    console.error('[ErrorBoundary]', err, info);
  }
  // Reset captured error when `resetKey` changes (typically the route
  // pathname). Only clear the error state — leave children alone so we
  // don't churn unrelated in-flight effects on every navigation.
  componentDidUpdate(prevProps) {
    if (this.state.err && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ err: null });
    }
  }
  render() {
    if (this.state.err) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-ink-50 p-6">
          <div className="max-w-md w-full bg-white border border-danger-200 rounded-card shadow-card p-8 space-y-4 text-center">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-danger-100 mx-auto">
              <svg className="w-6 h-6 text-danger-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            </div>
            <div className="space-y-1">
              <h1 className="text-base font-semibold text-ink-900">An unexpected error occurred</h1>
              <p className="text-sm text-ink-500">
                This page encountered a problem and could not be displayed. Navigating to another page or reloading will resolve it.
              </p>
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-danger-600 hover:bg-danger-700 text-white text-sm font-medium focus-visible:outline-none focus-visible:shadow-ring"
              onClick={() => location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
