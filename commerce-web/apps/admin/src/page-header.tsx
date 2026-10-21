import { createContext, useContext, type ReactNode } from 'react';
import './page-header.css';

/** Workspaces may nest page content beneath their own primary heading. */
export const PageHeadingLevel = createContext<1 | 2>(1);

/** One title/description/action layout for list, detail and unavailable screens. */
export function PageHeader({ title, description, actions }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  const Heading = useContext(PageHeadingLevel) === 2 ? 'h2' : 'h1';
  return <div className="admin-page-heading">
    <div className="admin-page-heading-copy">
      <Heading>{title}</Heading>
      {description && <p>{description}</p>}
    </div>
    {actions && <div className="admin-page-heading-actions">{actions}</div>}
  </div>;
}
