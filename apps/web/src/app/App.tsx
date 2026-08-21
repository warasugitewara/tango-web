import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router'
import { DeckListScreen } from '../screens/DeckListScreen'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
})

function PendingScreen(props: { title: string }) {
  return (
    <main className="shell">
      <h1>{props.title}</h1>
      <p>この画面を準備しています。</p>
    </main>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<DeckListScreen />} />
          <Route
            path="/decks/:deckId"
            element={<PendingScreen title="カード" />}
          />
          <Route path="/study" element={<PendingScreen title="学習" />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
