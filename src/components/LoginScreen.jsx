import React from 'react';
import { Layout } from 'lucide-react';

const LoginScreen = ({ onSignIn }) => (
  <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
    <div className="bg-white p-8 rounded-2xl shadow-xl max-w-sm w-full text-center">
      <div className="w-16 h-16 bg-indigo-600 rounded-xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-indigo-200">
        <Layout className="text-white" size={32} />
      </div>
      <h1 className="text-3xl font-black text-slate-900 mb-2">Spool</h1>
      <p className="text-slate-500 mb-8">Creative Workflow Management</p>
      <button
        onClick={onSignIn}
        className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-all shadow-md shadow-indigo-100 flex items-center justify-center gap-2"
      >
        <Layout size={20} /> Sign in with Google
      </button>
    </div>
  </div>
);

export default LoginScreen;
