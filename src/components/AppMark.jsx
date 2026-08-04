import { STITCH_MARK_PATHS } from '../app-marks';

/**
 * One Stitch Suite app mark, painted in `currentColor`. Size it with a class or
 * a style — the art carries its own padding inside the 64-unit grid, so it can
 * fill its tile edge to edge.
 */
export function AppMark({ id, className, style, title }) {
  const d = STITCH_MARK_PATHS[id];
  if (!d) return null;
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      style={style}
      fill="currentColor"
      role="img"
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <path d={d} fillRule="evenodd" />
    </svg>
  );
}
