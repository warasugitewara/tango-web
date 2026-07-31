import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

function App() {
  return (
    <main>
      <h1>Tango</h1>
    </main>
  )
}

const container = document.getElementById('root')

if (container === null) {
  throw new Error('マウント先の #root 要素が見つかりません')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
