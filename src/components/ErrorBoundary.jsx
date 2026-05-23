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
          <div className="max-w-md w-full bg-white border border-danger-200 rounded-card shadow-card p-6 space-y-3">
            <h1 className="font-bold text-danger-700">Something broke.</h1>
            <pre className="text-xs whitespace-pre-wrap text-ink-700 max-h-64 overflow-auto">
              {String(this.state.err?.message || this.state.err)}
            </pre>
            <button
              type="button"
              className="text-xs underline text-ink-600 hover:text-ink-900"
              onClick={() => location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
