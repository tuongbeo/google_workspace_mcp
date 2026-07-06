/**
 * Minimal response-shape interfaces for Google APIs.
 *
 * These are NOT full API schemas — only the fields tool handlers in this
 * directory actually read. Kept intentionally loose (mostly optional fields)
 * since Google's JSON responses omit empty/default fields. The goal is to
 * replace blind `as any` casts with enough structure that a typo'd field
 * name is a compile error instead of a silent `undefined`.
 */

// ── Google Chat ────────────────────────────────────────────────────────────────

export interface ChatSpace {
  name?: string;
  displayName?: string;
  spaceType?: string;
}

export interface ChatSpaceListResponse {
  spaces?: ChatSpace[];
}

export interface ChatMessage {
  name?: string;
  text?: string;
  createTime?: string;
  sender?: { name?: string; displayName?: string };
  space?: { name?: string };
}

export interface ChatMessageListResponse {
  messages?: ChatMessage[];
}

export interface ChatReaction {
  name?: string;
}

export interface ChatAttachment {
  name?: string;
  contentName?: string;
  contentType?: string;
  downloadUri?: string;
  attachmentDataRef?: { resourceName?: string };
  driveDataRef?: { driveFileId?: string };
}

// ── Google Calendar ────────────────────────────────────────────────────────────

export interface CalendarListEntry {
  id?: string;
  summary?: string;
  primary?: boolean;
  backgroundColor?: string;
}

export interface CalendarListResponse {
  items?: CalendarListEntry[];
}

export interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface ConferenceEntryPoint {
  entryPointType?: string;
  uri?: string;
}

export interface EventAttendee {
  email?: string;
  responseStatus?: string;
  self?: boolean;
  comment?: string;
}

export interface CalendarEvent {
  id?: string;
  summary?: string;
  status?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  location?: string;
  description?: string;
  htmlLink?: string;
  hangoutLink?: string;
  organizer?: { email?: string };
  attendees?: EventAttendee[];
  conferenceData?: { entryPoints?: ConferenceEntryPoint[] };
}

export interface CalendarEventListResponse {
  items?: CalendarEvent[];
}

export interface FreeBusyResponse {
  calendars?: Record<string, { busy?: { start?: string; end?: string }[] }>;
}

// ── Google Forms ───────────────────────────────────────────────────────────────

export interface FormQuestion {
  required?: boolean;
  textQuestion?: unknown;
  choiceQuestion?: { type?: string; options?: { value?: string }[] };
  scaleQuestion?: { low?: number; high?: number; lowLabel?: string; highLabel?: string };
  dateQuestion?: unknown;
  timeQuestion?: unknown;
  fileUploadQuestion?: unknown;
  rowQuestion?: unknown;
}

export interface FormItem {
  itemId?: string;
  title?: string;
  questionItem?: { question: FormQuestion };
  questionGroupItem?: { questions?: unknown[] };
  pageBreakItem?: unknown;
  textItem?: unknown;
  imageItem?: unknown;
}

export interface FormSettings {
  emailCollectionType?: string;
  limitOneResponsePerUser?: boolean;
  progressBar?: boolean;
  shuffleQuestions?: boolean;
  confirmationMessage?: { text?: string };
  quizSettings?: { isQuiz?: boolean; autoScore?: boolean; defaultFeedback?: { text?: string } };
}

export interface Form {
  formId?: string;
  info?: { title?: string; description?: string; documentTitle?: string };
  responderUri?: string;
  linkedSheetId?: string;
  settings?: FormSettings;
  items?: FormItem[];
}

export interface FormBatchUpdateResponse {
  replies?: unknown[];
}

export interface FormResponseAnswer {
  textAnswers?: { answers?: { value?: string }[] };
}

export interface FormResponse {
  responseId?: string;
  createTime?: string;
  answers?: Record<string, FormResponseAnswer>;
}

export interface FormResponseListResponse {
  responses?: FormResponse[];
}

// ── Google Tasks ───────────────────────────────────────────────────────────────

export interface GTaskList {
  id?: string;
  title?: string;
  updated?: string;
}

export interface GTaskListsResponse {
  items?: GTaskList[];
}

export interface GTask {
  id?: string;
  kind?: string;
  title?: string;
  status?: string;
  due?: string;
  notes?: string;
  completed?: string | null;
  position?: string;
}

export interface GTaskListResponse {
  items?: GTask[];
  nextPageToken?: string;
}

// ── Google Custom Search ─────────────────────────────────────────────────────

export interface CustomSearchItem {
  title?: string;
  link?: string;
  snippet?: string;
}

export interface CustomSearchResponse {
  items?: CustomSearchItem[];
  searchInformation?: { totalResults?: string };
}

export interface CustomSearchEngineInfo {
  title?: string;
  kind?: string;
}

// ── Gmail ──────────────────────────────────────────────────────────────────────

export interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
  headers?: { name: string; value: string }[];
}

export interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  payload?: GmailMessagePart;
  snippet?: string;
}

export interface GmailMessageListResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
}

export interface GmailThread {
  id?: string;
  messages?: GmailMessage[];
}

export interface GmailLabel {
  id?: string;
  name?: string;
  type?: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
}

export interface GmailLabelListResponse {
  labels?: GmailLabel[];
}

export interface GmailAttachment {
  size?: number;
  data?: string;
}

export interface GmailFilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
}

export interface GmailFilterAction {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
}

export interface GmailFilter {
  id?: string;
  criteria?: GmailFilterCriteria;
  action?: GmailFilterAction;
}

export interface GmailFilterListResponse {
  filter?: GmailFilter[];
}

// ── Google People (Contacts) ──────────────────────────────────────────────────

export interface PersonName {
  givenName?: string;
  familyName?: string;
  displayName?: string;
}

export interface Person {
  etag?: string;
  resourceName?: string;
  names?: PersonName[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  organizations?: { name?: string; title?: string }[];
  addresses?: { formattedValue?: string }[];
  biographies?: { value?: string }[];
}

export interface SearchContactsResponse {
  results?: { person?: Person }[];
  connections?: Person[];
}

export interface BatchCreateContactsResponse {
  createdPeople?: { person?: Person }[];
}

export interface ContactGroup {
  resourceName?: string;
  name?: string;
  groupType?: string;
  memberCount?: number;
  memberResourceNames?: string[];
}

export interface ContactGroupListResponse {
  contactGroups?: ContactGroup[];
}

// ── Google Slides ──────────────────────────────────────────────────────────────

export interface SlidesTextElement {
  textRun?: { content?: string };
}

export interface SlidesPageElement {
  objectId?: string;
  shape?: {
    text?: { textElements?: SlidesTextElement[] };
    placeholder?: { type?: string };
  };
}

export interface SlidesSlide {
  objectId?: string;
  slideNumber?: number;
  pageType?: string;
  pageElements?: SlidesPageElement[];
  slideProperties?: {
    notesPage?: { pageElements?: SlidesPageElement[] };
  };
}

export interface SlidesPresentation {
  title?: string;
  presentationId?: string;
  slides?: SlidesSlide[];
}

export interface SlidesBatchUpdateResponse {
  replies?: Array<{
    createSlide?: { objectId?: string };
    duplicateObject?: { objectId?: string };
    replaceAllText?: { occurrencesChanged?: number };
    replaceAllShapesWithImage?: { occurrencesChanged?: number };
    createImage?: { objectId?: string };
    createTable?: { objectId?: string };
  }>;
}

export interface SlidesThumbnail {
  contentUrl?: string;
  width?: number;
  height?: number;
}
