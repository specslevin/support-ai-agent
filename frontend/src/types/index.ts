export interface Issue {
  id: number
  external_id: number
  subject: string | null
  status: string | null
  priority: string | null
  company_name: string | null
  contact_name: string | null
  assignee_name: string | null
  created_at: string | null
  updated_at: string | null
  synced_at: string
  deadline_at: string | null
}

export interface ChatIssue {
  id: number
  external_id: number | null
  subject: string | null
  company_name: string | null
  status: string | null
  assignee_name: string | null
}

export interface ChatResponse {
  reply: string
  filters: Record<string, string>
  issues: ChatIssue[]
}

export interface Pagination {
  page: number
  limit: number
  total: number
  total_pages: number
}

export interface IssuesListResponse {
  data: Issue[]
  pagination: Pagination
}

export interface Analysis {
  id: number
  mileage_from_sheet: number | null
  mileage_from_system: number | null
  discrepancy_percent: number | null
  ai_suggestion: string | null
  recommendation: string | null
  created_at: string
}

export interface OkdeskDetail {
  description: string | null
  source: string | null
  deadline_at: string | null
  completed_at: string | null
  planned_reaction_at: string | null
  reacted_at: string | null
  delayed_to: string | null
  spent_time_total: number | null
  /** Правимые из карточки поля Okdesk (PATCH /issues/{id}/fields). */
  priority_code?: string | null
  planned_execution_in_hours?: number | null
  type_name: string | null
  type_code: string | null
  author_name: string | null
  service_object_name: string | null
  parent_id: number | null
  child_ids: number[]
  /**
   * Связанные заявки со статусом и темой (Okdesk в связях отдаёт только id —
   * подписи бэкенд достаёт из локального кэша заявок).
   */
  related?: RelatedIssue[]
  parameters: { name: string; value: string }[]
  /**
   * Обязательная тройка кастом-атрибутов по КОДАМ и с сырыми значениями — то, что
   * реально лежит в Okdesk. `parameters` — витрина для человека: она чистит мусор
   * и подставляет телефон, вытащенный из «Контактного лица», поэтому форма правки
   * обязана смотреть сюда, иначе поле выглядит заполненным, а атрибут пуст.
   */
  editable_parameters?: { code: string; name: string; value: string }[]
  /** Ссылка на эту заявку в портале Okdesk (домен знает только бэкенд). */
  okdesk_url?: string | null
}

export interface RelatedIssue {
  external_id: number
  role: 'parent' | 'child'
  subject: string | null
  status: string | null
  url: string | null
}

export interface IssueDetail {
  issue: Issue
  okdesk_detail: OkdeskDetail
  latest_analysis: Analysis | null
}

export interface Comment {
  id: number
  author: string
  content: string | null
  created_at: string | null
  is_internal: boolean | null
  is_public?: boolean
  author_kind?: string
}

export type StatusCode = 'opened' | 'in_progress' | 'resolved' | 'closed' | string

/**
 * Ярлык «почему заявка ушла из пробеговой лестницы»: заявка не о расхождении
 * пробега, а о работах с прибором (или о просьбе обнулить ложный пробег).
 * Список открытый — бэкенд может добавить ярлык, фронт покажет его как есть.
 */
export type KnownIssueIntent =
  | 'перемещение объекта'
  | 'замена прибора'
  | 'отключение / деактивация'
  | 'подключение'
  | 'установка / монтаж'
  | 'обнуление ложного пробега'

/** То, что реально приходит по сети: известный ярлык либо любой новый от бэкенда. */
export type IssueIntent = KnownIssueIntent | string

export interface AutomationParsed {
  plate: string | null
  date: string | null
  /**
   * Конец периода неисправности (ISO `YYYY-MM-DD`). Появляется у заявок вида
   * «нет данных с 10.02.2026» — разбор считает окно от названной даты до даты
   * создания заявки, то есть оно может быть в МЕСЯЦЫ. Пороги телеметрии
   * откалиброваны на сутки, поэтому по длинному окну метрики накопленные —
   * рядом с ними показываем длину периода (см. telemetryWindowDays).
   * Отсутствует или равен `date` → окно однодневное, показывать нечего.
   */
  date_to?: string | null
  sheet_mileage_km: number | null
  /**
   * Моточасы по путевому листу — у спецтехники клиент пишет «ПЛ-1 м/ч» вместо
   * километров. Это НЕ километры: в `sheet_mileage_km` их подставлять нельзя
   * (раньше такое значение приезжало туда как 0.001 км).
   */
  engine_hours?: number | null
  declared_system_km: number | null
  llm_extracted?: boolean
  plate_format_suspect?: boolean
  /**
   * Почему заявка вышла из пробеговой лестницы (установка, замена, отключение,
   * перемещение, подключение прибора, обнуление ложного пробега). null/отсутствие
   * — обычная заявка о расхождении пробега.
   */
  issue_intent?: IssueIntent | null
  /**
   * Год в дате неисправности исправлен НАМИ: клиент написал «01.07.2028» или
   * прошлогоднюю дату, разбор подставил год заявки. Это догадка системы, а не
   * текст клиента — рядом с датой показываем пометку. Поле необязательное:
   * разборы из старого кэша его не несут.
   */
  date_year_fixed?: boolean
}

export interface AutomationTelemetry {
  object_id: number | null
  object_name: string | null
  system_mileage_km: number | null
  max_speed: number | null
  move_time_min: number | null
  packets: number
  avg_sat: number | null
  low_sat_ratio: number | null
  min_power_v: number | null
  avg_power_v: number | null
  power_off_ratio: number | null
  max_gap_min: number | null
  zero_coord_moving_ratio: number | null
  max_speed_packet: number | null
  speed_spike_count: number
  teleport_jumps: number
  max_implied_kmh: number | null
  /**
   * Флаги телеметрии: `jamming_suspect`, `low_satellites`, `track_gap`,
   * `power_off`, `no_data`, `object_not_found`, `zero_coords`, `speed_spike`,
   * `teleport`, `sparse_data` (терминал почти не выходил на связь за сутки —
   * вероятна неисправность или демонтаж), `mileage_unreliable` (наш суточный
   * пробег накручен прострелами трека — цифру нельзя ни сравнивать с путевым
   * листом, ни отправлять клиенту), `tracker_silent` (терминал не выходил на
   * связь 30+ дней ДО даты неисправности — мёртвый прибор, нужен выезд),
   * `phantom_loop` (трек несколько раз прошёл один и тот же круг без остановок
   * на скорости под 100 км/ч и накрутил фантомные километры — подмена координат,
   * строка идёт в «Глушение», пробег недостоверен), `coord_gap_long` (терминал
   * дольше 25 минут присылал пакеты без координат — расстояние через провал
   * намеренно не достраиваем, пробег занижен), `gap_power_unknown` (длинный
   * разрыв трека, питание за период подтвердить нечем — «Глушение» не утверждаем).
   * Подписи — FLAG_LABELS в TelemetryPanel.
   */
  flags: string[]
  /**
   * Дата последнего сообщения терминала — смысл есть при флаге `tracker_silent`
   * («молчит с 16.03.2026»). Поле необязательное: старые кэши его не несут.
   */
  last_message_date?: string | null
}

/**
 * Чем получен вердикт. Определяет ВИД пилюли в интерфейсе, а не только текст:
 *   rules    — предварительный вердикт лестницы правил, бесплатный (DeepSeek не звали);
 *   ai       — вердикт DeepSeek (есть уверенность, обоснование, черновик);
 *   operator — ручная правка оператора (машина её не перезаписывает).
 * Поле опциональное: разборы, сохранённые до его появления, источника не несут —
 * такие считаем «rules» (ИИ бы записал себя явно).
 */
export type VerdictSource = 'rules' | 'ai' | 'operator'

export interface AutomationResult {
  parsed: AutomationParsed
  telemetry: AutomationTelemetry
  category: string
  confidence: number
  draft_answer: string
  reasoning: string
  needs_review: boolean
  needs_remote_diagnostics?: boolean
  spec_vehicle?: boolean
  auto_eligible?: boolean
  error: string | null
  // Чем получена category и что сказала детерминированная эвристика — нужно,
  // чтобы показать расхождение «правила → ИИ» без наведения мыши.
  verdict_source?: VerdictSource
  heuristic_category?: string | null
}

export interface TrackPoint {
  t: number
  lat: number | null
  lng: number | null
  speed: number
  sat: number
  pwr: number | null
}

export interface TrackObjectStatus {
  online?: boolean
  last_time?: number
  speed?: number
  sat?: number
}

export interface TrackData {
  parsed: AutomationParsed
  object_id?: number
  object_name?: string
  imei?: string | null
  phone?: string | null
  status?: TrackObjectStatus
  range_from?: string
  range_to?: string
  total_packets?: number
  points: TrackPoint[]
  teleports?: number[]
  error?: string
}

export interface BatchObject {
  file: string
  plate: string | null
  date: string | null
  /**
   * Конец окна телеметрии строки (ISO). Опционально: обычная строка из акта
   * описывает ОДИН день, поле приезжает только у заявок с периодом
   * («нет данных с …»). Нет поля или равно `date` → окно однодневное.
   */
  date_to?: string | null
  sheet_mileage_km: number | null
  /**
   * Моточасы (спецтехника): показываем как «м/ч», не как км. Приезжают и у
   * одиночной заявки (клиент пишет «ПЛ-1 м/ч»), и у строк из ВЛОЖЕНИЙ —
   * табличный XLSX «Группировка», колонка «Моточасы».
   */
  engine_hours?: number | null
  declared_system_km?: number | null
  system_mileage_km: number | null
  address?: string | null
  flags: string[]
  teleport_jumps: number
  // Полная телеметрия объекта. Опционально: старые записи кэша разбора её не
  // содержат, а у нераспознанных строк (нет номера/даты) она null.
  telemetry?: AutomationTelemetry | null
  verdict: string
  verdict_edited?: boolean
  plate_edited?: boolean
  date_edited?: boolean
  /** Пробег («ПЛ» и/или «ГЛОНАСС заявл.») поправил оператор — `POST /batch/mileage`. */
  mileage_edited?: boolean
  /**
   * НАСТОЯЩАЯ спецтехника: распознана по модели (трактор, погрузчик, АГП,
   * автовышка…) либо по спецформату номера («73ОО5235», «СУ5297»). Просто
   * битый или усечённый номер сюда БОЛЬШЕ НЕ ПОПАДАЕТ — он помечается только
   * через `parsed.plate_format_suspect` (два разных признака, см. VerdictCell
   * и PlateSuspectMark).
   */
  spec_vehicle?: boolean
  /**
   * Чему в этой строке нельзя доверять. Список открытый, известные значения:
   *   `region_conflict`      — код региона в заявке ≠ регион найденного объекта;
   *   `act_numbers_differ`   — текст и таблица одного акта дают разные пробеги;
   *   `two_dates_one_plate`  — у ТС две разные даты из разных вложений;
   *   `mileage_unreliable`   — `system_mileage_km` накручен прострелами трека;
   *   `date_from_filename`   — дата взята из имени файла (день ОТПРАВКИ письма),
   *                            рабочая «Дата неисправности» лежит внутри акта;
   *   `act_name_body_differ` — имя файла и тело документа называют разные акты
   *                            («№ТР140» в имени против «№ТР126 от 29.07» внутри):
   *                            под вопросом происхождение строки, не её цифры;
   *   `mileage_in_hours`     — в графе пробега стоит время («41 ч»), а не км:
   *                            спецтехника, число ушло в `engine_hours`;
   *   `duplicate_in_source`  — ТС задвоен в письме, позиции схлопнуты в одну строку;
   *   `shift_window`         — клиент жаловался на конкретную СМЕНУ («26.06.2026
   *                            08.00-20.00 60км»), а пробег и телеметрия строки
   *                            посчитаны за полные сутки: окно смены в расчёт не
   *                            берём, пороги вердиктов откалиброваны на сутки.
   * Причинный вердикт при непустом массиве бэкенд сам разворачивает в
   * «Проверить» — фронт показывает ПРИЧИНУ (WARNING_LABELS/WARNING_HINTS).
   * ИСКЛЮЧЕНИЯ — `mileage_unreliable`, `mileage_in_hours`, `duplicate_in_source`,
   * `shift_window`: вердикт они не разжалуют (рваный трек сам признак глушения;
   * км-вердикта по моточасам и не бывает; схлопывание дублей верное; сутки против
   * смены — осознанный компромисс), поэтому чип у них спокойный
   * (NON_DEMOTING_WARNINGS).
   * Поле необязательное: старые записи кэша разбора его не несут.
   */
  warnings?: string[]
  /**
   * Похожие номера ИЗ ПАРКА, когда объект по номеру заявки не найден. Раньше
   * разбор молча подбирал похожую машину и выносил вердикт по ЧУЖОМУ ТС
   * (`Е900КЕ` при `Е900КА` в парке). Решение владельца проекта: не подбирать
   * вовсе — «Объект не найден» плюс эта подсказка, номер правит оператор.
   */
  similar_plates?: string[] | null
  /** Строку завёл оператор вручную (`POST /batch/row`), в акте её не нашли. */
  manual_row?: boolean
  /**
   * Появляются после платного прогона ИИ по всей заявке (`POST /batch/ai`):
   * до него у строки есть только вердикт правил, обосновывать нечего.
   */
  confidence?: number | null
  reasoning?: string | null
  draft_answer?: string | null
  /** Кто и когда переписал вердикт вручную (`verdict_source === 'operator'`). */
  verdict_edited_by?: string | null
  verdict_edited_at?: string | null
  // Чем получен вердикт строки (см. VerdictSource) и что сказала вторая,
  // более простая эвристика. Опциональны: старые кэши разбора их не содержат.
  verdict_source?: VerdictSource
  heuristic_category?: string | null
}

// Прогресс возобновляемого OCR: complete=false → распознаны не все страницы
// вложений (сервер слаб, большой PDF идёт порциями), фронт авто-дораспознаёт.
export interface OcrProgress {
  complete: boolean
  attachments_total: number
  attachments_done: number
  pages_done: number
}

export interface BatchResult {
  total: number
  jamming_count: number
  ok_count: number
  is_aggregate?: boolean
  objects: BatchObject[]
  /**
   * Сводные факты заявки (ярлык `issue_intent`, признак правки года в дате).
   * Опционально: ответы batch-эндпоинтов правки строк его не содержат, а старые
   * кэши разбора не знают о нём вовсе.
   */
  parsed?: AutomationParsed | null
  ocr_progress?: OcrProgress
  /** Когда по заявке звали ИИ (`POST /batch/ai`) — платная кнопка после этого гаснет. */
  ai_called_at?: string | null
  /** Пояснение прогона ИИ (например, «разобраны первые 25 объектов из 40»). */
  ai_note?: string | null
  /**
   * Сводный ответ по всей заявке, написанный моделью в том же вызове. null, если
   * модель упомянула гос.номер, которого в заявке нет — такой текст отбрасывается
   * (бэкенд сверяет номера с составом заявки).
   */
  ai_summary_answer?: string | null
}

/**
 * Ответ `/issues/{id}/parse` — ДЕТЕРМИНИРОВАННЫЙ разбор без DeepSeek: факты
 * (номер, дата, пробеги, телеметрия) + предварительный вердикт по правилам.
 * Форма строк та же, что у пакетного разбора (`objects`), поэтому таблица одна
 * и та же и для 1 объекта, и для 20. Сводные поля дублируют единственную строку.
 * Токены не тратятся никогда; OCR — только при `attachments=true`.
 */
export interface ParseResult {
  parsed: AutomationParsed
  objects: BatchObject[]
  total: number
  jamming_count: number
  ok_count: number
  telemetry?: AutomationTelemetry | null
  verdict?: string | null
  heuristic_category?: string | null
  verdict_source?: VerdictSource | null
  spec_vehicle?: boolean
  needs_remote_diagnostics?: boolean
  is_aggregate?: boolean
  /** Пояснение, почему разбор пуст (номер не найден по теме/тексту). */
  note?: string
  /** Есть только у разбора с вложениями (`attachments=true`). */
  ocr_progress?: OcrProgress
  /**
   * Документ правили вручную (вердикт, номер, дата, пробег, добавленная или
   * удалённая строка). Одиночная карточка по умолчанию рисует более богатый кэш
   * `automate`, но ручные правки пишутся сюда — с этим флагом главным становится
   * `parse`, иначе после перезагрузки страницы правка пропадала бы с экрана.
   */
  operator_touched?: boolean
  /** Появляются после прогона ИИ по строкам (`POST /batch/ai`). */
  confidence?: number | null
  reasoning?: string | null
  draft_answer?: string | null
  ai_called_at?: string | null
  ai_note?: string | null
}

// «Передать монтажнику»: два готовых текста (КАЛЕНДАРЬ + МЕССЕНДЖЕР) + поля.
export interface InstallerExport {
  calendar: string
  messenger: string
  fields: {
    phone: string | null
    company_short: string | null
    city: string | null
    vehicle: string | null
    plate: string | null
    date: string | null
    status_line: string
    contact_name: string | null
    address: string | null
  }
}

// Этап 2: suggested placeholder->value map for dynamic templates.
export interface TemplateValues {
  values: Record<string, string>
}

/**
 * Что ИИ уже прочитал в конкретном файле (кэш `ocr:<att_id>` на бэкенде).
 * `unavailable` — растровый скан без текстового слоя, `partial` — большой PDF
 * дочитан до N-й страницы, `queued` — ещё не читался.
 */
export interface AttachmentOcr {
  status: 'done' | 'partial' | 'queued' | 'unavailable'
  pages_done: number
  complete: boolean
}

export interface IssueAttachment {
  id: number
  name: string | null
  size: number | null
  is_public: boolean | null
  kind: string
  extractable: boolean
  ocr?: AttachmentOcr
}

export interface Template {
  id: number
  name: string
  content: string
  category_id: number
  category_name: string | null
  category_color: string | null
  usage_count: number
  is_favorite: boolean
  is_dynamic: boolean
  /** NULL = shared (visible to everyone); a username = personal (owner only). */
  user_id: string | null
}

export interface TemplateCategory {
  id: number
  name: string
  color: string | null
}

export interface TemplateCreate {
  name: string
  content: string
  category_id?: number | null
  is_dynamic?: boolean
  is_favorite?: boolean
  /** When true the template is owned by the current user (personal). */
  is_personal?: boolean
}

export interface TemplateUpdate {
  name?: string
  content?: string
  category_id?: number | null
  is_dynamic?: boolean
  is_favorite?: boolean
  active?: boolean
}

// Петля обратной связи по качеству ИИ-разбора заявки.
/** Набор условий фильтра, хранимый в сохранённом пресете. */
export interface SavedFilterValues {
  status?: string
  company?: string
  search?: string
  assignee?: string
  issueId?: string
  sort?: string
  order?: 'asc' | 'desc'
}

/** Личный сохранённый фильтр списка заявок (GET /saved-filters). */
export interface SavedFilter {
  id: number
  name: string
  filters: SavedFilterValues
  position: number
  created_at: string
  updated_at: string
}

/** Тело POST /saved-filters. */
export interface SavedFilterCreate {
  name: string
  filters: SavedFilterValues
  position?: number
}

/** Тело PUT /saved-filters/{id}. */
export interface SavedFilterUpdate {
  name?: string
  filters?: SavedFilterValues
  position?: number
}

export type AiFeedbackRating = 'good' | 'bad'
export type AiFeedbackErrorKind = 'wrong_verdict' | 'wrong_plate' | 'wrong_date' | 'wrong_mileage' | 'other'

/** Тело запроса POST /issues/{id}/ai_feedback */
export interface AiFeedbackBody {
  rating: AiFeedbackRating
  error_kind?: AiFeedbackErrorKind
  comment?: string
  correct_category?: string
  /** Чей разбор оценивают: правила (бесплатно), ИИ или правка оператора. */
  verdict_source?: 'rules' | 'ai' | 'operator'
}

/** Сохранённая оценка ИИ-разбора (GET /issues/{id}/ai_feedback → feedback). */
export interface AiFeedback {
  rating: AiFeedbackRating
  error_kind: AiFeedbackErrorKind | null
  comment: string | null
  ai_category: string | null
  correct_category: string | null
  /** null у оценок, выставленных до того, как оценивать разрешили и правила. */
  verdict_source?: 'rules' | 'ai' | 'operator' | null
  created_by: string | null
  created_at: string | null
}

/** Элемент списка GET /issues/ai_feedback/list */
export interface AiFeedbackListItem {
  id: number
  issue_external_id: number
  rating: AiFeedbackRating
  error_kind: AiFeedbackErrorKind | null
  comment: string | null
  ai_category: string | null
  correct_category: string | null
  verdict_source?: 'rules' | 'ai' | 'operator' | null
  created_by: string | null
  created_at: string | null
  resolved?: boolean
  resolved_by?: string | null
  resolved_at?: string | null
}
