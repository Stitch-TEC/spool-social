import React, { Component } from 'react';
import { AlertTriangle } from 'lucide-react';

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error, info) {
    // Keep the actual exception in the browser console for a connected Safari
    // inspector, while the visible copy stays calm and contains no client data.
    console.error('Spool display error:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
          <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md text-center border border-rose-100">
            <div className="w-12 h-12 bg-rose-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="text-rose-500" />
            </div>
            <h2 className="text-xl font-bold text-slate-800 mb-2">Spool hit a display error</h2>
            <p className="text-slate-500 mb-6">Your content is still safe. Reload Spool to try again.</p>
            <button onClick={() => window.location.reload()} className="bg-slate-900 text-white px-6 py-2 rounded-lg font-bold">
              Reload App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
