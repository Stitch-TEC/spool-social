import React, { useState } from 'react';
import { X, Upload, Trash2, CheckCircle, Palette, Save } from 'lucide-react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../config/firebase';
import { processImageFile } from '../utils/helpers';

const ClientSettingsModal = ({ onClose, uniqueClients, clientMap, isReadOnly }) => {
  const [selectedClient, setSelectedClient] = useState(uniqueClients[0] || '');
  const [newClientName, setNewClientName] = useState('');

  // ⚡ OPTIMIZATION: Initialize state from props to avoid unnecessary effect/re-render
  const [logoUrl, setLogoUrl] = useState(() => {
    const initial = uniqueClients[0];
    return (initial && clientMap[initial]) ? (clientMap[initial].logoUrl || '') : '';
  });
  const [brandColor, setBrandColor] = useState(() => {
    const initial = uniqueClients[0];
    return (initial && clientMap[initial]) ? (clientMap[initial].brandColor || '#4f46e5') : '#4f46e5';
  });

  const [isSaving, setIsSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // ⚡ OPTIMIZATION: Handle state updates in the change handler instead of a sync effect
  // to prevent cascading renders and improve performance.
  const handleClientChange = (val) => {
    setSelectedClient(val);
    if (val && val !== 'NEW' && clientMap[val]) {
      setLogoUrl(clientMap[val].logoUrl || '');
      setBrandColor(clientMap[val].brandColor || '#4f46e5');
    } else {
      setLogoUrl('');
      setBrandColor('#4f46e5');
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      try {
        const processedImage = await processImageFile(file);
        setLogoUrl(processedImage);
      } catch (err) {
        console.error(err);
        alert('Error processing image');
      }
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      try {
        const processedImage = await processImageFile(file);
        setLogoUrl(processedImage);
      } catch (err) {
        console.error(err);
        alert('Error processing image');
      }
    }
  };

  const handleSave = async () => {
    if (isReadOnly) return;
    const activeClient = (selectedClient === 'NEW' ? newClientName.trim() : selectedClient).replace(/\//g, '').slice(0, 50);
    if (!activeClient) return alert('Enter a valid client name');

    // 🛡️ SECURITY: Validate brandColor format
    const hexRegex = /^#[0-9A-F]{6}$/i;
    if (brandColor && !hexRegex.test(brandColor)) {
      return alert('Invalid brand color format');
    }
    
    setIsSaving(true);
    try {
      await setDoc(doc(db, 'clients', activeClient), {
        name: activeClient,
        logoUrl: (logoUrl || '').slice(0, 500000),
        brandColor
      }, { merge: true });
      setIsSaving(false);
      onClose();
    } catch (err) {
      console.error(err);
      alert('Error saving client settings');
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <Palette size={20} className="text-indigo-500" />
            Client Brand Settings
          </h2>
          <button 
            onClick={onClose} 
            className="p-2 text-slate-400 hover:bg-slate-100 rounded-full transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto w-full">
          {/* Client Select */}
          <div className="mb-6">
            <label className="block text-sm font-bold text-slate-700 mb-2">Select Client</label>
            <select
              value={selectedClient}
              onChange={(e) => handleClientChange(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500 transition-all font-medium"
            >
              <optgroup label="Extracted From Threads">
                {uniqueClients.map(c => (
                   <option key={c} value={c}>{c}</option>
                ))}
              </optgroup>
              <optgroup label="Other">
                <option value="NEW">+ Add New Client Manually</option>
              </optgroup>
            </select>
          </div>

          {selectedClient === 'NEW' && (
            <div className="mb-6">
              <label className="block text-sm font-bold text-slate-700 mb-2">Client Name</label>
              <input
                type="text"
                placeholder="e.g. My Awesome Startup"
                maxLength={50}
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500 transition-all"
              />
            </div>
          )}

          {/* Logo Upload */}
          <div className="mb-6">
            <label className="block text-sm font-bold text-slate-700 mb-2">Brand Logo</label>
            <div 
              className={`w-full h-32 rounded-xl border-2 border-dashed flex items-center justify-center relative overflow-hidden transition-all ${
                isDragging ? 'border-indigo-500 bg-indigo-50 scale-[1.02]' : 'border-slate-300 bg-slate-50 hover:bg-slate-100'
              }`}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
              onDrop={handleDrop}
            >
              {!logoUrl ? (
                <label className="w-full h-full flex flex-col items-center justify-center cursor-pointer p-4 text-center">
                  <div className={`p-3 rounded-full mb-2 ${isDragging ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-200 text-slate-500'}`}>
                    <Upload size={20} />
                  </div>
                  <p className={`text-xs font-medium ${isDragging ? 'text-indigo-600' : 'text-slate-500'}`}>
                    {isDragging ? 'Drop logo here' : 'Drop transparent PNG/JPG logo'}
                  </p>
                  <input type="file" className="hidden" accept="image/*" onChange={handleFileUpload} />
                </label>
              ) : (
                <div className="relative w-full h-full p-2 bg-slate-100 flex items-center justify-center">
                  <img src={logoUrl} className="max-w-full max-h-full object-contain" alt="Client Logo" />
                  <button 
                    onClick={() => setLogoUrl('')} 
                    title="Remove Logo"
                    className="absolute top-2 right-2 p-1.5 bg-black/50 text-white rounded-full hover:bg-rose-600 transition-colors backdrop-blur-sm"
                  >
                    <Trash2 size={14}/>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Color Picker */}
          <div className="mb-6">
            <label className="block text-sm font-bold text-slate-700 mb-2">Primary Brand Color</label>
            <div className="flex gap-4 items-center">
              <input 
                type="color" 
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                className="w-12 h-12 rounded cursor-pointer border-0 p-0"
              />
              <div className="flex-1 font-mono text-sm tracking-wider uppercase text-slate-600 p-2 bg-slate-100 rounded border border-slate-200">
                {brandColor}
              </div>
            </div>
            <p className="text-xs text-slate-400 mt-2">Used for accents in previews (buttons, borders, etc.)</p>
          </div>

        </div>

        <div className="p-4 border-t border-slate-100 bg-slate-50 flex items-center justify-end gap-3 rounded-b-2xl">
          <button 
            onClick={onClose}
            className="px-4 py-2 font-bold text-slate-500 hover:text-slate-700 text-sm transition-colors"
          >
            Cancel
          </button>
          <button 
            onClick={handleSave}
            disabled={isSaving || (selectedClient === 'NEW' && !newClientName.trim()) || isReadOnly}
            className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2 font-bold rounded-lg text-sm shadow-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSaving ? <span className="animate-pulse">Saving...</span> : <><Save size={16}/> Save Brand Info</>}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ClientSettingsModal;
