import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchBar, type SearchInitialState } from '../search';
export default function SearchWidget({ initialState }: { initialState?: SearchInitialState }) {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}><SearchBar initialState={initialState} /></QueryClientProvider>;
}
