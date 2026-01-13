import React from 'react';
import { AlertCircle } from 'lucide-react';
import { PLATFORMS } from '../constants';

const PlatformIcon = ({ platformId, size = 18, className = "" }) => {
  const platform = PLATFORMS[platformId] || PLATFORMS.gmb;
  const Icon = platform.icon || AlertCircle; 
  return (
    <div className={`flex items-center justify-center rounded-full text-white ${platform.color} ${className}`} style={{ width: size, height: size }}>
      <Icon size={size * 0.6} />
    </div>
  );
};

export default PlatformIcon;