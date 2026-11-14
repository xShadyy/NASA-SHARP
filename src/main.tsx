import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@mantine/core/styles/baseline.css'
import '@mantine/core/styles/default-css-variables.css'
import '@mantine/core/styles/global.css'
import './index.css'
import App from './App.tsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, gcTime: 120_000, retry: 1, refetchOnWindowFocus: false } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}><App /></QueryClientProvider>
  </StrictMode>,
)
