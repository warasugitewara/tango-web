import type {
  CardContentInput,
  DeckCreateInput,
  ImportRequest,
  PublicRating,
  ReviewSubmitInput,
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

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  })
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
  async listDecks(): Promise<readonly DeckSummary[]> {
    const body = await request('/api/decks')
    if (!isRecord(body) || !Array.isArray(body.decks)) {
      throw new ApiClientError('INVALID_RESPONSE', 'デッキを読み込めません。')
    }
    return body.decks.map(parseDeck)
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
  async listCards(deckId: string): Promise<readonly CardRecord[]> {
    const body = await request(`/api/decks/${deckId}/cards`)
    if (!isRecord(body) || !Array.isArray(body.cards)) {
      throw new ApiClientError('INVALID_RESPONSE', 'カードを読み込めません。')
    }
    return body.cards.map(parseCard)
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
}
