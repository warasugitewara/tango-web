import type {
  CardContentInput,
  DeckCreateInput,
  DeckUpdateInput,
  ImportRequest,
  PublicRating,
  ReviewSubmitInput,
  ReviewUndoInput,
  StudySessionCreateInput,
} from '@tango/shared'

export type SessionView =
  | { authenticated: false }
  | {
      authenticated: true
      kind: 'guest'
      expiresAt: string
      warning: string
    }
  | {
      authenticated: true
      kind: 'user'
      user: { id: string; name: string; image: string | null }
      providers: readonly string[]
    }

export type DeckSummary = {
  id: string
  name: string
  description: string | null
  newCardLimit: number
  cardCount: number
}

export type CardRecord = {
  id: string
  deckId: string
  front: string
  back: string
  contentHash: string
  createdAt: string
  updatedAt: string
}

/** デッキ一覧に添える当日の残り枚数。 */
export type DeckQueue = {
  deckId: string
  remainingReview: number
  remainingLearning: number
  remainingNew: number
}

/** 直近の学習量。`reviews` は取り消しを差し引いた実効枚数。 */
export type ActivityDay = {
  learningDay: string
  reviews: number
}

/** デッキ一覧の先頭に出す進捗。 */
export type StudyDashboard = {
  learningDay: string
  completedToday: number
  streakDays: number
  remaining: {
    review: number
    learning: number
    new: number
  }
  activity: readonly ActivityDay[]
  nextDueAt: string | null
}

/** アカウント統合の比較に出す、片方ぶんの規模。 */
export type MergeCandidateView = {
  userId: string
  name: string
  providers: readonly string[]
  decks: number
  cards: number
  reviews: number
  lastReviewedAt: string | null
}

export type MergePreview = {
  current: MergeCandidateView
  other: MergeCandidateView
}

/** 書き出したデッキの中身。取り込みと同じ封筒。 */
export type DeckExport = {
  schema: 'tango.content'
  version: 1
  cards: readonly { front: string; back: string }[]
}

/** カード一覧の1ページ。`total` はゴミ箱を除いたデッキ内の総数。 */
export type CardPage = {
  cards: readonly CardRecord[]
  total: number
}

export type StudySessionView = {
  sessionId: string
  learningDay: string
  card: { id: string; deckId: string; front: string; back: string } | null
  schedule: { scheduleVersion: number } | null
  intervalPreviews: Readonly<
    Record<PublicRating, { dueAt: string; scheduledDays: number }>
  > | null
  remainingReview: number
  remainingLearning: number
  remainingNew: number
}

export type TrashedDeckView = {
  id: string
  name: string
  cardCount: number
  trashedAt: string
}

export type TrashedCardView = {
  id: string
  deckId: string
  deckName: string
  front: string
  trashedAt: string
}

export type TrashView = {
  retentionDays: number
  decks: readonly TrashedDeckView[]
  cards: readonly TrashedCardView[]
}

export class ApiClientError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new ApiClientError(
      'INVALID_RESPONSE',
      'サーバー応答を解釈できません。',
    )
  }
  return value
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiClientError(
      'INVALID_RESPONSE',
      'サーバー応答を解釈できません。',
    )
  }
  return value
}

function parseSession(value: unknown): SessionView {
  if (!isRecord(value) || typeof value.authenticated !== 'boolean') {
    throw new ApiClientError('INVALID_RESPONSE', 'セッションを確認できません。')
  }
  if (!value.authenticated) {
    return { authenticated: false }
  }
  if (value.kind === 'guest') {
    return {
      authenticated: true,
      kind: 'guest',
      expiresAt: requiredString(value, 'expiresAt'),
      warning: requiredString(value, 'warning'),
    }
  }
  if (value.kind === 'user' && isRecord(value.user)) {
    const image = value.user.image
    const providers = value.providers
    if (
      (image !== null && typeof image !== 'string') ||
      !Array.isArray(providers) ||
      !providers.every((provider) => typeof provider === 'string')
    ) {
      throw new ApiClientError(
        'INVALID_RESPONSE',
        'セッションを確認できません。',
      )
    }
    return {
      authenticated: true,
      kind: 'user',
      user: {
        id: requiredString(value.user, 'id'),
        name: requiredString(value.user, 'name'),
        image,
      },
      providers,
    }
  }
  throw new ApiClientError('INVALID_RESPONSE', 'セッションを確認できません。')
}

function parseDeck(value: unknown): DeckSummary {
  if (!isRecord(value)) {
    throw new ApiClientError('INVALID_RESPONSE', 'デッキを読み込めません。')
  }
  const description = value.description
  if (
    (description !== null && typeof description !== 'string') ||
    typeof value.newCardLimit !== 'number' ||
    typeof value.cardCount !== 'number'
  ) {
    throw new ApiClientError('INVALID_RESPONSE', 'デッキを読み込めません。')
  }
  return {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    description,
    newCardLimit: value.newCardLimit,
    cardCount: value.cardCount,
  }
}

function parseTrashedDeck(value: unknown): TrashedDeckView {
  if (!isRecord(value) || typeof value.cardCount !== 'number') {
    throw new ApiClientError('INVALID_RESPONSE', 'ゴミ箱を読み込めません。')
  }
  return {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    cardCount: value.cardCount,
    trashedAt: requiredString(value, 'trashedAt'),
  }
}

function parseTrashedCard(value: unknown): TrashedCardView {
  if (!isRecord(value)) {
    throw new ApiClientError('INVALID_RESPONSE', 'ゴミ箱を読み込めません。')
  }
  return {
    id: requiredString(value, 'id'),
    deckId: requiredString(value, 'deckId'),
    deckName: requiredString(value, 'deckName'),
    front: requiredString(value, 'front'),
    trashedAt: requiredString(value, 'trashedAt'),
  }
}

function parseDeckQueue(value: unknown): DeckQueue {
  if (!isRecord(value)) {
    throw new ApiClientError('INVALID_RESPONSE', '残り枚数を読み込めません。')
  }
  return {
    deckId: requiredString(value, 'deckId'),
    remainingReview: requiredNumber(value, 'remainingReview'),
    remainingLearning: requiredNumber(value, 'remainingLearning'),
    remainingNew: requiredNumber(value, 'remainingNew'),
  }
}

function parseActivityDay(value: unknown): ActivityDay {
  if (!isRecord(value)) {
    throw new ApiClientError('INVALID_RESPONSE', '学習量を読み込めません。')
  }
  return {
    learningDay: requiredString(value, 'learningDay'),
    reviews: requiredNumber(value, 'reviews'),
  }
}

function parseDashboard(value: unknown): StudyDashboard {
  if (!isRecord(value) || !Array.isArray(value.activity)) {
    throw new ApiClientError('INVALID_RESPONSE', '進捗を読み込めません。')
  }
  const remaining = value.remaining
  if (!isRecord(remaining)) {
    throw new ApiClientError('INVALID_RESPONSE', '進捗を読み込めません。')
  }
  const nextDueAt = value.nextDueAt
  if (nextDueAt !== null && typeof nextDueAt !== 'string') {
    throw new ApiClientError('INVALID_RESPONSE', '進捗を読み込めません。')
  }

  return {
    learningDay: requiredString(value, 'learningDay'),
    completedToday: requiredNumber(value, 'completedToday'),
    streakDays: requiredNumber(value, 'streakDays'),
    remaining: {
      review: requiredNumber(remaining, 'review'),
      learning: requiredNumber(remaining, 'learning'),
      new: requiredNumber(remaining, 'new'),
    },
    activity: value.activity.map(parseActivityDay),
    nextDueAt,
  }
}

function parseMergeCandidate(value: unknown): MergeCandidateView {
  if (!isRecord(value) || !Array.isArray(value.providers)) {
    throw new ApiClientError('INVALID_RESPONSE', '統合の情報を読み込めません。')
  }
  const lastReviewedAt = value.lastReviewedAt
  if (lastReviewedAt !== null && typeof lastReviewedAt !== 'string') {
    throw new ApiClientError('INVALID_RESPONSE', '統合の情報を読み込めません。')
  }

  return {
    userId: requiredString(value, 'userId'),
    name: requiredString(value, 'name'),
    providers: value.providers.map((provider) =>
      typeof provider === 'string' ? provider : '',
    ),
    decks: requiredNumber(value, 'decks'),
    cards: requiredNumber(value, 'cards'),
    reviews: requiredNumber(value, 'reviews'),
    lastReviewedAt,
  }
}

function parseDeckExport(value: unknown): DeckExport {
  if (
    !isRecord(value) ||
    value.schema !== 'tango.content' ||
    value.version !== 1 ||
    !Array.isArray(value.cards)
  ) {
    throw new ApiClientError(
      'INVALID_RESPONSE',
      '書き出しデータを読み込めません。',
    )
  }

  return {
    schema: 'tango.content',
    version: 1,
    cards: value.cards.map((card) => {
      if (!isRecord(card)) {
        throw new ApiClientError(
          'INVALID_RESPONSE',
          '書き出しデータを読み込めません。',
        )
      }
      return {
        front: requiredString(card, 'front'),
        back: requiredString(card, 'back'),
      }
    }),
  }
}

function parseCard(value: unknown): CardRecord {
  if (!isRecord(value)) {
    throw new ApiClientError('INVALID_RESPONSE', 'カードを読み込めません。')
  }
  return {
    id: requiredString(value, 'id'),
    deckId: requiredString(value, 'deckId'),
    front: requiredString(value, 'front'),
    back: requiredString(value, 'back'),
    contentHash: requiredString(value, 'contentHash'),
    createdAt: requiredString(value, 'createdAt'),
    updatedAt: requiredString(value, 'updatedAt'),
  }
}

function parseStudyCard(value: unknown): StudySessionView['card'] {
  if (value === null) {
    return null
  }
  if (!isRecord(value)) {
    throw new ApiClientError('INVALID_RESPONSE', '学習状態を読み込めません。')
  }
  return {
    id: requiredString(value, 'id'),
    deckId: requiredString(value, 'deckId'),
    front: requiredString(value, 'front'),
    back: requiredString(value, 'back'),
  }
}

function parseStudySchedule(value: unknown): StudySessionView['schedule'] {
  if (value === null) {
    return null
  }
  if (!isRecord(value)) {
    throw new ApiClientError('INVALID_RESPONSE', '学習状態を読み込めません。')
  }
  return { scheduleVersion: requiredNumber(value, 'scheduleVersion') }
}

function parseIntervalPreview(value: unknown) {
  if (!isRecord(value)) {
    throw new ApiClientError('INVALID_RESPONSE', '学習状態を読み込めません。')
  }
  return {
    dueAt: requiredString(value, 'dueAt'),
    scheduledDays: requiredNumber(value, 'scheduledDays'),
  }
}

function parseIntervalPreviews(
  value: unknown,
): StudySessionView['intervalPreviews'] {
  if (value === null) {
    return null
  }
  if (!isRecord(value)) {
    throw new ApiClientError('INVALID_RESPONSE', '学習状態を読み込めません。')
  }
  return {
    1: parseIntervalPreview(value['1']),
    2: parseIntervalPreview(value['2']),
    3: parseIntervalPreview(value['3']),
    4: parseIntervalPreview(value['4']),
  }
}

function parseStudySession(value: unknown): StudySessionView {
  if (!isRecord(value)) {
    throw new ApiClientError('INVALID_RESPONSE', '学習状態を読み込めません。')
  }
  const card = parseStudyCard(value.card)
  const schedule = parseStudySchedule(value.schedule)
  const intervalPreviews = parseIntervalPreviews(value.intervalPreviews)
  if (
    (card === null) !== (schedule === null) ||
    (card === null) !== (intervalPreviews === null)
  ) {
    throw new ApiClientError('INVALID_RESPONSE', '学習状態を読み込めません。')
  }
  return {
    sessionId: requiredString(value, 'sessionId'),
    learningDay: requiredString(value, 'learningDay'),
    card,
    schedule,
    intervalPreviews,
    remainingReview: requiredNumber(value, 'remainingReview'),
    remainingLearning: requiredNumber(value, 'remainingLearning'),
    remainingNew: requiredNumber(value, 'remainingNew'),
  }
}

/** 二重送信トークンを載せるヘッダ。サーバの検査名と揃える。 */
const CSRF_HEADER = 'X-Tango-CSRF'

/** 取得済みのトークン。タブの生存中は使い回す。 */
let csrfToken: string | null = null

async function fetchCsrfToken(): Promise<string> {
  const response = await fetch('/api/security/csrf', {
    credentials: 'same-origin',
  })

  if (!response.ok) {
    throw new ApiClientError(
      'INTERNAL_ERROR',
      '通信の準備に失敗しました。画面を再読み込みしてください。',
    )
  }

  const body: unknown = await response.json()

  if (!isRecord(body) || typeof body.csrfToken !== 'string') {
    throw new ApiClientError(
      'INVALID_RESPONSE',
      '通信の準備に失敗しました。画面を再読み込みしてください。',
    )
  }

  csrfToken = body.csrfToken
  return body.csrfToken
}

/** 変更を伴う要求かどうか。安全なメソッドはトークンを必要としない。 */
function isMutation(method: string | undefined): boolean {
  return method !== undefined && method.toUpperCase() !== 'GET'
}

async function send(
  path: string,
  init: RequestInit | undefined,
  token: string | null,
): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...(token === null ? {} : { [CSRF_HEADER]: token }),
      ...init?.headers,
    },
  })
}

async function toResult(response: Response): Promise<unknown> {
  const body: unknown = response.status === 204 ? null : await response.json()
  if (!response.ok) {
    if (isRecord(body) && isRecord(body.error)) {
      const code = body.error.code
      const message = body.error.message
      if (typeof code === 'string' && typeof message === 'string') {
        throw new ApiClientError(code, message)
      }
    }
    throw new ApiClientError('INTERNAL_ERROR', '通信に失敗しました。')
  }
  return body
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const mutating = isMutation(init?.method)

  if (!mutating) {
    return toResult(await send(path, init, null))
  }

  const token = csrfToken ?? (await fetchCsrfToken())
  const response = await send(path, init, token)

  // Cookieの期限切れや別タブでの再発行でトークンが古くなることがある。
  // 一度だけ取り直して再送する。再送は同じ内容なので副作用は増えない。
  if (response.status === 403) {
    const refreshed = await fetchCsrfToken()
    return toResult(await send(path, init, refreshed))
  }

  return toResult(response)
}

export const apiClient = {
  async session(): Promise<SessionView> {
    return parseSession(await request('/api/session'))
  },
  async startGuest(turnstileToken: string): Promise<SessionView> {
    return parseSession(
      await request('/api/guest/start', {
        method: 'POST',
        body: JSON.stringify({ turnstileToken }),
      }),
    )
  },
  /**
   * サインインの開始URLを取得する。
   * Better Authはサインイン応答で署名済みstate Cookieを張り、
   * コールバックで突き合わせる。必ずブラウザから呼ぶこと。
   */
  async signInUrl(
    provider: 'google' | 'github',
    callbackURL = '/auth/complete',
  ): Promise<string> {
    const body = await request('/api/auth/sign-in/social', {
      method: 'POST',
      body: JSON.stringify({ provider, callbackURL }),
    })
    if (!isRecord(body) || typeof body.url !== 'string') {
      throw new ApiClientError(
        'INVALID_RESPONSE',
        'ログインを開始できませんでした。',
      )
    }
    return body.url
  },
  /**
   * 既にログイン済みのアカウントへ別のプロバイダを結び付ける。
   * 暗黙のリンクは無効なので、この明示操作だけが連携の入口になる。
   */
  async linkSocialUrl(provider: 'google' | 'github'): Promise<string> {
    const body = await request('/api/auth/link-social', {
      method: 'POST',
      body: JSON.stringify({ provider, callbackURL: '/auth/complete' }),
    })
    if (!isRecord(body) || typeof body.url !== 'string') {
      throw new ApiClientError(
        'INVALID_RESPONSE',
        '連携を開始できませんでした。',
      )
    }
    return body.url
  },
  /** 連携を解除する。最後の1つはサーバ側が拒否する。 */
  async unlinkAccount(provider: 'google' | 'github'): Promise<void> {
    await request('/api/auth/unlink-account', {
      method: 'POST',
      body: JSON.stringify({ providerId: provider }),
    })
  },
  /** 別アカウントとの統合を始める。証明のCookieをサーバが発行する。 */
  async startMerge(): Promise<void> {
    await request('/api/identity/merge/start', { method: 'POST' })
  },
  /** 統合するアカウント双方の規模。 */
  async mergePreview(): Promise<MergePreview> {
    const body = await request('/api/identity/merge/preview')
    if (!isRecord(body)) {
      throw new ApiClientError(
        'INVALID_RESPONSE',
        '統合の情報を読み込めません。',
      )
    }
    return {
      current: parseMergeCandidate(body.current),
      other: parseMergeCandidate(body.other),
    }
  },
  /** 統合を確定する。`signedOut` が真なら、いまのセッションは消えている。 */
  async confirmMerge(keep: 'current' | 'other'): Promise<boolean> {
    const body = await request('/api/identity/merge/confirm', {
      method: 'POST',
      body: JSON.stringify({ keep }),
    })
    return isRecord(body) && body.signedOut === true
  },
  /** ゲストから正式アカウントへの引き継ぎを確定する。 */
  async completeIdentity(mergeKey: string): Promise<void> {
    await request('/api/identity/complete', {
      method: 'POST',
      body: JSON.stringify({ mergeKey }),
    })
  },
  async signOut(): Promise<void> {
    await request('/api/auth/sign-out', { method: 'POST', body: '{}' })
  },
  /** ゴミ箱の一覧。保持期限内のものだけが返る。 */
  async listTrash(): Promise<TrashView> {
    const body = await request('/api/trash')
    if (
      !isRecord(body) ||
      typeof body.retentionDays !== 'number' ||
      !Array.isArray(body.decks) ||
      !Array.isArray(body.cards)
    ) {
      throw new ApiClientError('INVALID_RESPONSE', 'ゴミ箱を読み込めません。')
    }
    return {
      retentionDays: body.retentionDays,
      decks: body.decks.map(parseTrashedDeck),
      cards: body.cards.map(parseTrashedCard),
    }
  },
  async restoreDeck(deckId: string): Promise<void> {
    await request(`/api/trash/decks/${deckId}/restore`, { method: 'POST' })
  },
  async restoreCard(cardId: string): Promise<void> {
    await request(`/api/trash/cards/${cardId}/restore`, { method: 'POST' })
  },
  async listDecks(): Promise<readonly DeckSummary[]> {
    const body = await request('/api/decks')
    if (!isRecord(body) || !Array.isArray(body.decks)) {
      throw new ApiClientError('INVALID_RESPONSE', 'デッキを読み込めません。')
    }
    return body.decks.map(parseDeck)
  },
  /** デッキごとの当日残数。デッキ一覧と突き合わせて表示する。 */
  async listDeckQueues(): Promise<readonly DeckQueue[]> {
    const body = await request('/api/study/decks')
    if (!isRecord(body) || !Array.isArray(body.decks)) {
      throw new ApiClientError('INVALID_RESPONSE', '残り枚数を読み込めません。')
    }
    return body.decks.map(parseDeckQueue)
  },
  /** デッキ一覧の先頭に出す進捗の集計。 */
  async dashboard(): Promise<StudyDashboard> {
    return parseDashboard(await request('/api/study/dashboard'))
  },
  /** デッキの中身を取り込みと同じ封筒で書き出す。 */
  async exportDeck(deckId: string): Promise<DeckExport> {
    return parseDeckExport(await request(`/api/decks/${deckId}/export`))
  },
  async createDeck(input: DeckCreateInput): Promise<DeckSummary> {
    const body = await request('/api/decks', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    if (!isRecord(body)) {
      throw new ApiClientError('INVALID_RESPONSE', 'デッキを作成できません。')
    }
    return parseDeck(body.deck)
  },
  async updateDeck(
    deckId: string,
    input: DeckUpdateInput,
  ): Promise<DeckSummary> {
    const body = await request(`/api/decks/${deckId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
    if (!isRecord(body)) {
      throw new ApiClientError('INVALID_RESPONSE', 'デッキを更新できません。')
    }
    return parseDeck(body.deck)
  },
  async deleteDeck(deckId: string): Promise<void> {
    await request(`/api/decks/${deckId}`, { method: 'DELETE' })
  },
  async listCards(
    deckId: string,
    page: { limit: number; offset: number },
  ): Promise<CardPage> {
    const query = new URLSearchParams({
      limit: String(page.limit),
      offset: String(page.offset),
    })
    const body = await request(`/api/decks/${deckId}/cards?${query.toString()}`)
    if (
      !isRecord(body) ||
      !Array.isArray(body.cards) ||
      typeof body.total !== 'number'
    ) {
      throw new ApiClientError('INVALID_RESPONSE', 'カードを読み込めません。')
    }
    return { cards: body.cards.map(parseCard), total: body.total }
  },
  async createCard(
    deckId: string,
    input: CardContentInput,
  ): Promise<CardRecord> {
    const body = await request(`/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
    if (!isRecord(body)) {
      throw new ApiClientError('INVALID_RESPONSE', 'カードを作成できません。')
    }
    return parseCard(body.card)
  },
  async updateCard(
    cardId: string,
    input: CardContentInput,
  ): Promise<CardRecord> {
    const body = await request(`/api/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
    if (!isRecord(body)) {
      throw new ApiClientError('INVALID_RESPONSE', 'カードを更新できません。')
    }
    return parseCard(body.card)
  },
  async deleteCard(cardId: string): Promise<void> {
    await request(`/api/cards/${cardId}`, { method: 'DELETE' })
  },
  async importCards(deckId: string, input: ImportRequest): Promise<number> {
    const body = await request(`/api/decks/${deckId}/import`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
    if (!isRecord(body) || typeof body.created !== 'number') {
      throw new ApiClientError('INVALID_RESPONSE', 'カードを取り込めません。')
    }
    return body.created
  },
  async createStudySession(
    input: StudySessionCreateInput,
  ): Promise<StudySessionView> {
    return parseStudySession(
      await request('/api/study/sessions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    )
  },
  async getStudySession(sessionId: string): Promise<StudySessionView> {
    return parseStudySession(await request(`/api/study/sessions/${sessionId}`))
  },
  async submitReview(input: ReviewSubmitInput): Promise<void> {
    await request('/api/study/reviews', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  /** 直前の評価を取り消し、取り消した後のセッション状態を受け取る。 */
  async undoLastReview(input: ReviewUndoInput): Promise<StudySessionView> {
    return parseStudySession(
      await request('/api/study/reviews/undo', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    )
  },
}
