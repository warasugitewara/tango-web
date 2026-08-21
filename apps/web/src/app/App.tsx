import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router'
import { AuthCompleteScreen } from '../screens/AuthCompleteScreen'
import { DeckDetailScreen } from '../screens/DeckDetailScreen'
import { DeckListScreen } from '../screens/DeckListScreen'
import { StudyScreen } from '../screens/StudyScreen'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<DeckListScreen />} />
          <Route path="/decks/:deckId" element={<DeckDetailScreen />} />
          <Route path="/study" element={<StudyScreen />} />
          <Route path="/auth/complete" element={<AuthCompleteScreen />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
