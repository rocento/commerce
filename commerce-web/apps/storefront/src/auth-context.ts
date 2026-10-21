import { createContext, useContext } from 'react';
import type { Customer } from '@commerce/api-client';

export const AuthContext = createContext<{
  customer: Customer | null;
  setCustomer: (customer: Customer | null) => void;
}>({ customer: null, setCustomer: () => {} });
export const useAuth = () => useContext(AuthContext);
