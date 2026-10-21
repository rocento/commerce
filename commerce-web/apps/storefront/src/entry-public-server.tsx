import { renderToString } from 'react-dom/server';
import { PublicPage } from './public/page';
import type { PublicSnapshot } from './public/types';
export function render(snapshot: PublicSnapshot) { return renderToString(<PublicPage snapshot={snapshot} />); }
