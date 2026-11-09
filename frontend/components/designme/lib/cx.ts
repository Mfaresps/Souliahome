// every component imports this, so the tap areas for touch screens (./hits) start with the first one
import './hits';
/** Joins class names, skipping empty ones */
export const cx = (...names: Array<string | false | null | undefined | 0>) => names.filter(Boolean).join(' ');
