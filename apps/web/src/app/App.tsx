import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { DeckListScreen } from '../screens/DeckListScreen'

/*
 * 最初に開く単語帳一覧だけを同梱し、ほかの画面は開いたときに読む。
 * カード本文の Markdown 描画は一覧では使わないため、初回の読み込みから外せる。
 * デプロイで古いチャンクが消えて読めないときは ErrorBoundary が再読み込みを促す。
 */
const DeckDetailScreen = lazy(() =>
  import('../screens/DeckDetailScreen').then((module) => ({
    default: module.DeckDetailScreen,
  })),
)
const StudyScreen = lazy(() =>
  import('../screens/StudyScreen').then((module) => ({
    default: module.StudyScreen,
  })),
)
const TrashScreen = lazy(() =>
  import('../screens/TrashScreen').then((module) => ({
    default: module.TrashScreen,
  })),
)
const AuthCompleteScreen = lazy(() =>
  import('../screens/AuthCompleteScreen').then((module) => ({
    default: module.AuthCompleteScreen,
  })),
)
const MergeScreen = lazy(() =>
  import('../screens/MergeScreen').then((module) => ({
    default: module.MergeScreen,
  })),
)
const AccountDeleteScreen = lazy(() =>
  import('../screens/AccountDeleteScreen').then((module) => ({
    default: module.AccountDeleteScreen,
  })),
)
const NotFoundScreen = lazy(() =>
  import('../screens/NotFoundScreen').then((module) => ({
    default: module.NotFoundScreen,
  })),
)

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
})

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Suspense fallback={<main className="shell">読み込み中…</main>}>
            <Routes>
              <Route path="/" element={<DeckListScreen />} />
              <Route path="/decks/:deckId" element={<DeckDetailScreen />} />
              <Route path="/study" element={<StudyScreen />} />
              <Route path="/auth/complete" element={<AuthCompleteScreen />} />
              <Route path="/trash" element={<TrashScreen />} />
              <Route path="/auth/merge" element={<MergeScreen />} />
              <Route path="/account/delete" element={<AccountDeleteScreen />} />
              <Route path="*" element={<NotFoundScreen />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
