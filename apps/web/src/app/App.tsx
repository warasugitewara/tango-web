import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router'
import { AccountDeleteScreen } from '../screens/AccountDeleteScreen'
import { AuthCompleteScreen } from '../screens/AuthCompleteScreen'
import { DeckDetailScreen } from '../screens/DeckDetailScreen'
import { DeckListScreen } from '../screens/DeckListScreen'
import { MergeScreen } from '../screens/MergeScreen'
import { StudyScreen } from '../screens/StudyScreen'
import { TrashScreen } from '../screens/TrashScreen'

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
          <Route path="/trash" element={<TrashScreen />} />
          <Route path="/auth/merge" element={<MergeScreen />} />
          <Route path="/account/delete" element={<AccountDeleteScreen />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
