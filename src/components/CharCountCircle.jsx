import React from 'react';

const CharCountCircle = ({ current, max }) => {
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const percentage = Math.min(100, (current / max) * 100);
  const strokeDashoffset = circumference - (percentage / 100) * circumference;
  
  let color = 'stroke-indigo-500';
  if (percentage > 80) color = 'stroke-amber-500';
  if (percentage > 95) color = 'stroke-rose-500';

  return (
    <div className="relative w-8 h-8 flex items-center justify-center">
      <svg className="transform -rotate-90 w-full h-full">
        <circle className="text-slate-200" strokeWidth="3" stroke="currentColor" fill="transparent" r={radius} cx="16" cy="16" />
        <circle className={`${color} transition-all duration-300`} strokeWidth="3" strokeDasharray={circumference} strokeDashoffset={strokeDashoffset} strokeLinecap="round" stroke="currentColor" fill="transparent" r={radius} cx="16" cy="16" />
      </svg>
      {percentage > 100 && (
         <div className="absolute inset-0 flex items-center justify-center"><span className="text-[10px] font-bold text-rose-600">!</span></div>
      )}
    </div>
  );
};

export default CharCountCircle;