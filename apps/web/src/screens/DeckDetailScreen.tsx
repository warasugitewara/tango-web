import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { apiClient, type CardRecord, type DeckSummary } from '../api/client'
import { invalidateContent, queryKeys } from '../api/query-keys'
import { CardMarkdown } from '../components/CardMarkdown'
import { UndoNoticeSlot } from '../components/UndoNotice'
import { useUndoNotice } from '../hooks/useUndoNotice'
import { downloadJson, toSafeFileName } from '../lib/download'
import { isSubmitShortcut } from '../lib/keyboard'

/** カード一覧の1ページに出す枚数。APIのlimit上限100の範囲に収める。 */
const PAGE_SIZE = 50

/** 新規上限として受け付ける範囲。共有契約の `deckUpdateSchema` と揃える。 */
const NEW_CARD_LIMIT_MAX = 1_000

/** カード本文の上限。共有契約の `cardContentSchema` と揃える。 */
const CARD_TEXT_MAX = 20_000

/** 取り込み内容の上限。共有契約の `importRequestSchema` と揃える。 */
const IMPORT_PAYLOAD_MAX = 1_000_000

type ImportFormat = 'json' | 'csv'

/** 形式ごとの書き方の見本。サーバの取り込み規則（`import-parser.ts`）に合わせる。 */
const IMPORT_EXAMPLES: Record<ImportFormat, string> = {
  json: '{"schema":"tango.content","version":1,"cards":[{"front":"apple","back":"りんご"}]}',
  csv: 'front,back\napple,りんご\n"a, b","カンマを含むときは二重引用符で囲む"',
}

function parseNewCardLimit(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null
  }
  const parsed = Number(value)
  return parsed <= NEW_CARD_LIMIT_MAX ? parsed : null
}

/** 拡張子から形式を推し量る。分からなければ今の選択を保つ。 */
function formatFromFileName(
  fileName: string,
  current: ImportFormat,
): ImportFormat {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.csv')) {
    return 'csv'
  }
  if (lower.endsWith('.json')) {
    return 'json'
  }
  return current
}

/** Ctrl / ⌘ + Enter で、複数行の入力欄からそのままフォームを送る。 */
function submitOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>): void {
  if (isSubmitShortcut(event)) {
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }
}

/**
 * デッキ名・説明・新規上限をまとめて更新する。
 * 変更はPATCHで送るが、部分更新の差分計算は持たず3項目を常に送る。
 * 画面が持つ値がそのまま保存される形にして、押した結果を読み違えないようにする。
 */
function DeckSettingsForm(props: { deck: DeckSummary }) {
  const { deck } = props
  const queryClient = useQueryClient()
  const [name, setName] = useState(deck.name)
  const [description, setDescription] = useState(deck.description ?? '')
  const [newCardLimit, setNewCardLimit] = useState(String(deck.newCardLimit))
  const parsedLimit = parseNewCardLimit(newCardLimit)
  const update = useMutation({
    mutationFn: (input: {
      name: string
      description: string
      newCardLimit: number
    }) => apiClient.updateDeck(deck.id, input),
    // 新規上限は当日の残数を変え、名前はゴミ箱の表示にも出る。
    onSuccess: () => invalidateContent(queryClient),
  })

  return (
    <details className="content-panel panel-disclosure">
      <summary>デッキの設定</summary>
      <form
        className="deck-settings-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (parsedLimit === null) {
            return
          }
          update.mutate({
            name: name.trim(),
            description,
            newCardLimit: parsedLimit,
          })
        }}
      >
        <label>
          デッキ名
          <input
            value={name}
            maxLength={100}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
        </label>
        <label>
          説明
          <textarea
            value={description}
            maxLength={1_000}
            onChange={(event) => {
              setDescription(event.target.value)
            }}
          />
        </label>
        <label>
          1日の新規上限
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={NEW_CARD_LIMIT_MAX}
            value={newCardLimit}
            onChange={(event) => {
              setNewCardLimit(event.target.value)
            }}
          />
        </label>
        <button
          type="submit"
          disabled={
            update.isPending || name.trim() === '' || parsedLimit === null
          }
        >
          設定を保存
        </button>
      </form>
      {parsedLimit === null ? (
        <p className="form-error">
          新規上限は0以上{NEW_CARD_LIMIT_MAX}以下の整数で入力してください。
        </p>
      ) : null}
      <div role="status">
        {update.isSuccess && !update.isPending ? (
          <p>設定を保存しました。</p>
        ) : null}
      </div>
      {update.isError ? (
        <p className="form-error" role="alert">
          {update.error.message}
        </p>
      ) : null}
    </details>
  )
}

function EditCardForm(props: { card: CardRecord }) {
  const { card } = props
  const queryClient = useQueryClient()
  const disclosure = useRef<HTMLDetailsElement>(null)
  const [front, setFront] = useState(card.front)
  const [back, setBack] = useState(card.back)
  const unchanged = front === card.front && back === card.back
  const close = () => {
    if (disclosure.current !== null) {
      disclosure.current.open = false
      disclosure.current.querySelector('summary')?.focus()
    }
  }
  const update = useMutation({
    mutationFn: () => apiClient.updateCard(card.id, { front, back }),
    onSuccess: async () => {
      // 保存できたら閉じる。開いたままだと保存されたのか読み取れない。
      close()
      await invalidateContent(queryClient, card.deckId)
    },
  })

  return (
    <details
      className="card-edit"
      ref={disclosure}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          close()
        }
      }}
    >
      <summary>編集</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!unchanged && front.trim() !== '' && back.trim() !== '') {
            update.mutate()
          }
        }}
      >
        <label>
          表
          <textarea
            value={front}
            maxLength={CARD_TEXT_MAX}
            onChange={(event) => setFront(event.target.value)}
            onKeyDown={submitOnShortcut}
          />
        </label>
        <label>
          裏
          <textarea
            value={back}
            maxLength={CARD_TEXT_MAX}
            onChange={(event) => setBack(event.target.value)}
            onKeyDown={submitOnShortcut}
          />
        </label>
        <div className="form-actions">
          <button
            type="submit"
            disabled={
              update.isPending ||
              unchanged ||
              front.trim() === '' ||
              back.trim() === ''
            }
          >
            変更を保存
          </button>
          <button type="button" className="quiet-button" onClick={close}>
            閉じる
          </button>
        </div>
        {update.isError ? (
          <p className="form-error" role="alert">
            {update.error.message}
          </p>
        ) : null}
      </form>
    </details>
  )
}

function CardCreateForm(props: { deckId: string }) {
  const { deckId } = props
  const queryClient = useQueryClient()
  const frontField = useRef<HTMLTextAreaElement>(null)
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [createdCount, setCreatedCount] = useState(0)
  const create = useMutation({
    mutationFn: () => apiClient.createCard(deckId, { front, back }),
    onSuccess: async () => {
      setFront('')
      setBack('')
      setCreatedCount((count) => count + 1)
      // 続けて入れる人がほとんど。表の欄へ戻しておく。
      frontField.current?.focus()
      await invalidateContent(queryClient, deckId)
    },
  })
  const empty = front.trim() === '' || back.trim() === ''

  return (
    <section className="content-panel">
      <h2>カードを追加</h2>
      <form
        className="card-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!empty && !create.isPending) {
            create.mutate()
          }
        }}
      >
        <label>
          表
          <textarea
            ref={frontField}
            value={front}
            maxLength={CARD_TEXT_MAX}
            onChange={(event) => setFront(event.target.value)}
            onKeyDown={submitOnShortcut}
          />
        </label>
        <label>
          裏
          <textarea
            value={back}
            maxLength={CARD_TEXT_MAX}
            onChange={(event) => setBack(event.target.value)}
            onKeyDown={submitOnShortcut}
          />
        </label>
        <button type="submit" disabled={create.isPending || empty}>
          追加
        </button>
      </form>
      <p className="form-hint">
        Ctrl（Macは⌘）+ Enter でも追加できます。Markdownが使えます。
      </p>
      <div role="status">
        {createdCount === 0 ? null : (
          <p>カードを追加しました（この画面で{createdCount}枚）。</p>
        )}
      </div>
      {create.isError ? (
        <p className="form-error" role="alert">
          {create.error.message}
        </p>
      ) : null}
    </section>
  )
}

function ImportPanel(props: { deckId: string }) {
  const { deckId } = props
  const queryClient = useQueryClient()
  const [format, setFormat] = useState<ImportFormat>('json')
  const [payload, setPayload] = useState('')
  const [fileError, setFileError] = useState<string | null>(null)
  const [importedCount, setImportedCount] = useState<number | null>(null)
  const importCards = useMutation({
    mutationFn: () => apiClient.importCards(deckId, { format, payload }),
    onSuccess: async (created) => {
      setImportedCount(created)
      // 同じ内容をもう一度送ると重複して作られる。成功したら空にする。
      setPayload('')
      await invalidateContent(queryClient, deckId)
    },
  })

  const readFile = async (file: File) => {
    setFileError(null)
    setImportedCount(null)
    const text = await file.text()
    if (text.length > IMPORT_PAYLOAD_MAX) {
      setFileError(
        'ファイルが大きすぎます。いくつかに分けて取り込んでください。',
      )
      return
    }
    setFormat((current) => formatFromFileName(file.name, current))
    setPayload(text)
  }

  return (
    <details className="content-panel panel-disclosure">
      <summary>JSON / CSVを取り込む</summary>
      <form
        className="import-form"
        onSubmit={(event) => {
          event.preventDefault()
          importCards.mutate()
        }}
      >
        <label>
          ファイルから読み込む
          <input
            type="file"
            accept=".json,.csv,application/json,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file !== undefined) {
                readFile(file).catch(() => {
                  setFileError('ファイルを読み込めませんでした。')
                })
              }
            }}
          />
        </label>
        <label>
          形式
          <select
            value={format}
            onChange={(event) =>
              setFormat(event.target.value === 'csv' ? 'csv' : 'json')
            }
          >
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </select>
        </label>
        <label>
          取り込み内容
          <textarea
            value={payload}
            maxLength={IMPORT_PAYLOAD_MAX}
            placeholder={IMPORT_EXAMPLES[format]}
            onChange={(event) => setPayload(event.target.value)}
          />
        </label>
        <p className="form-hint">
          {format === 'csv'
            ? '1行目は「front,back」にしてください。'
            : '書き出したファイルはそのまま取り込めます。'}
          同じ内容を取り込むと重複して作られます。
        </p>
        <button
          type="submit"
          disabled={payload.trim() === '' || importCards.isPending}
        >
          {importCards.isPending ? '取り込んでいます…' : '取り込む'}
        </button>
      </form>
      <div role="status">
        {importedCount === null ? null : (
          <p>{importedCount}枚を作成しました。</p>
        )}
      </div>
      {fileError === null ? null : (
        <p className="form-error" role="alert">
          {fileError}
        </p>
      )}
      {importCards.isError ? (
        <p className="form-error" role="alert">
          {importCards.error.message}
        </p>
      ) : null}
    </details>
  )
}

function ExportPanel(props: { deckId: string; deckName: string | null }) {
  const { deckId, deckName } = props
  const exportDeck = useMutation({
    mutationFn: () => apiClient.exportDeck(deckId),
    onSuccess: (content) => {
      downloadJson(`${toSafeFileName(deckName ?? 'deck')}.tango.json`, content)
    },
  })

  return (
    <details className="content-panel panel-disclosure">
      <summary>書き出す</summary>
      <p>取り込みと同じJSON形式で保存する。そのまま取り込み直せる。</p>
      <button
        type="button"
        disabled={exportDeck.isPending}
        onClick={() => exportDeck.mutate()}
      >
        書き出す
      </button>
      <div role="status">
        {exportDeck.isSuccess ? (
          <p>書き出しました（{exportDeck.data.cards.length}枚）。</p>
        ) : null}
      </div>
      {exportDeck.isError ? (
        <p className="form-error" role="alert">
          {exportDeck.error.message}
        </p>
      ) : null}
    </details>
  )
}

export function DeckDetailScreen() {
  const { deckId } = useParams()
  const resolvedDeckId = deckId ?? ''
  const queryClient = useQueryClient()
  const undo = useUndoNotice()
  const listHeading = useRef<HTMLHeadingElement>(null)
  const [offset, setOffset] = useState(0)

  const cards = useQuery({
    queryKey: queryKeys.cardPage(resolvedDeckId, offset),
    queryFn: () =>
      apiClient.listCards(resolvedDeckId, { limit: PAGE_SIZE, offset }),
    enabled: deckId !== undefined,
    // ページを送るあいだ前のページを残し、一覧が一瞬消えて跳ねるのを防ぐ。
    placeholderData: keepPreviousData,
  })
  const total = cards.data?.total ?? 0
  const shown = cards.data?.cards.length ?? 0

  // 削除や取り込みで総数が変わると、今の位置が範囲外になることがある。
  // その場合は最後のページへ寄せて、空の画面のまま止まらないようにする。
  useEffect(() => {
    if (cards.data !== undefined && offset > 0 && offset >= total) {
      setOffset(Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE))
    }
  }, [cards.data, offset, total])

  // デッキ単体の取得APIは持たない。一覧は利用者ごとに小さく、
  // 単語帳一覧と同じキャッシュを共有できるため、そこから引く。
  const decks = useQuery({
    queryKey: queryKeys.decks,
    queryFn: () => apiClient.listDecks(),
    enabled: deckId !== undefined,
  })
  const deck = decks.data?.find((candidate) => candidate.id === resolvedDeckId)
  const remove = useMutation({
    mutationFn: (cardId: string) => apiClient.deleteCard(cardId),
    // ゴミ箱から戻せるので確認は挟まない。押した直後に元に戻す手段を出す。
    onSuccess: async (_unused, cardId) => {
      undo.show('カードをゴミ箱へ移しました。', async () => {
        await apiClient.restoreCard(cardId)
        await invalidateContent(queryClient, resolvedDeckId)
      })
      await invalidateContent(queryClient, resolvedDeckId)
    },
  })

  const goToPage = (nextOffset: number) => {
    setOffset(nextOffset)
    // 一覧の末尾で押すと、新しいページの途中から見えてしまう。先頭へ戻す。
    const heading = listHeading.current
    if (heading !== null && typeof heading.scrollIntoView === 'function') {
      heading.scrollIntoView({ block: 'start' })
    }
  }

  if (deckId === undefined) {
    throw new Error('デッキIDがありません。')
  }

  // 一覧を取り終えても見つからないなら、削除済みか他人のデッキ。
  if (decks.isSuccess && deck === undefined) {
    return (
      <main className="shell">
        <title>単語帳が見つかりません | Tango</title>
        <h1>単語帳が見つかりません</h1>
        <p>削除されたか、URLが間違っている可能性があります。</p>
        <p className="inline-links">
          <Link to="/">単語帳へ戻る</Link>
          <Link to="/trash">ゴミ箱を見る</Link>
        </p>
      </main>
    )
  }

  return (
    <main className="shell">
      <title>{`${deck?.name ?? 'カード'} | Tango`}</title>
      <header className="detail-header">
        <div>
          <Link to="/">← 単語帳へ</Link>
          <h1>{deck === undefined ? 'カード' : deck.name}</h1>
        </div>
        {/* 空のデッキで学習へ進んでも「完了です」としか出ない。 */}
        {cards.data !== undefined && total === 0 ? null : (
          <Link className="study-link" to={`/study?deckId=${deckId}`}>
            この単語帳を学習
          </Link>
        )}
      </header>

      <CardCreateForm deckId={resolvedDeckId} />

      <div className="panel-group">
        <ImportPanel deckId={resolvedDeckId} />
        <ExportPanel deckId={resolvedDeckId} deckName={deck?.name ?? null} />
        {deck === undefined ? null : (
          <DeckSettingsForm deck={deck} key={deck.id} />
        )}
      </div>

      <UndoNoticeSlot
        notice={undo.notice}
        undoing={undo.undoing}
        error={undo.error}
        onDismiss={undo.dismiss}
      />
      {remove.isError ? (
        <p className="form-error" role="alert">
          {remove.error.message}
        </p>
      ) : null}

      <section className="card-list" aria-labelledby="card-list-heading">
        <h2 id="card-list-heading" ref={listHeading} className="list-heading">
          カード一覧
        </h2>
        {cards.isPending ? <p>カードを読み込み中…</p> : null}
        {cards.isError ? (
          <p className="error-panel" role="alert">
            {cards.error.message}
          </p>
        ) : null}
        {cards.data !== undefined && total === 0 ? (
          <p className="empty-state">
            カードはまだありません。上の「カードを追加」から1枚ずつ入れるか、
            JSON / CSVでまとめて取り込めます。
          </p>
        ) : null}
        {cards.data === undefined || total === 0 ? null : (
          <p className="card-range">
            {total}枚中 {offset + 1}〜{offset + shown}枚を表示
          </p>
        )}
        {cards.data?.cards.map((card, index) => (
          <article className="content-card" key={card.id}>
            <span className="card-number">
              {String(offset + index + 1).padStart(2, '0')}
            </span>
            <div className="card-face">
              <span>表</span>
              <CardMarkdown text={card.front} />
            </div>
            <div className="card-face">
              <span>裏</span>
              <CardMarkdown text={card.back} />
            </div>
            <div className="card-controls">
              <EditCardForm card={card} key={card.updatedAt} />
              <button
                className="danger-button"
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate(card.id)}
              >
                削除
              </button>
            </div>
          </article>
        ))}
        {total > PAGE_SIZE ? (
          <nav className="card-paging" aria-label="カード一覧のページ送り">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => goToPage(Math.max(0, offset - PAGE_SIZE))}
            >
              前の50件
            </button>
            <button
              type="button"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => goToPage(offset + PAGE_SIZE)}
            >
              次の50件
            </button>
          </nav>
        ) : null}
      </section>
    </main>
  )
}
