import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
export function StatusField({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label>{Children.map(children, child => isValidElement(child) && ['input', 'select', 'textarea'].includes(String(child.type)) ? cloneElement(child as ReactElement<{ id: string }>, { id }) : child)}</div>;
}
