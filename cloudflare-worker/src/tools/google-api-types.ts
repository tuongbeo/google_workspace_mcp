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
  title?: string;
  status?: string;
  due?: string;
  notes?: string;
  completed?: string | null;
  position?: string;
}

export interface GTaskListResponse {
  items?: GTask[];
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

// ── Google Docs ────────────────────────────────────────────────────────────────

export interface DocsTextRun {
  content?: string;
  suggestedInsertionIds?: string[];
  suggestedDeletionIds?: string[];
}

export interface DocsPerson {
  personProperties?: { name?: string; email?: string };
}

export interface DocsParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: DocsTextRun;
  person?: DocsPerson;
  suggestedInsertions?: Record<string, { suggestionsMetadata?: unknown }>;
  suggestedDeletions?: Record<string, { suggestionsMetadata?: unknown }>;
}

export interface DocsParagraph {
  paragraphStyle?: { namedStyleType?: string };
  elements?: DocsParagraphElement[];
}

export interface DocsTableCell {
  content?: DocsStructuralElement[];
}

export interface DocsTableRow {
  tableCells?: DocsTableCell[];
}

export interface DocsTable {
  rows?: number;
  columns?: number;
  tableRows?: DocsTableRow[];
}

export interface DocsStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: DocsParagraph;
  table?: DocsTable;
  tableOfContents?: unknown;
  sectionBreak?: unknown;
}

export interface DocsTabProperties {
  tabId?: string;
  title?: string;
  iconEmoji?: string;
  index?: number;
  parentTabId?: string;
}

export interface DocsTab {
  tabProperties?: DocsTabProperties;
  documentTab?: { body?: { content?: DocsStructuralElement[] } };
  childTabs?: DocsTab[];
}

export interface DocsDocumentStyle {
  defaultHeaderId?: string;
  defaultFooterId?: string;
  marginTop?: { magnitude?: number; unit?: string };
  marginBottom?: { magnitude?: number; unit?: string };
  marginLeft?: { magnitude?: number; unit?: string };
  marginRight?: { magnitude?: number; unit?: string };
  pageSize?: {
    width?: { magnitude?: number; unit?: string };
    height?: { magnitude?: number; unit?: string };
  };
}

export interface DocsHeaderFooterSegment {
  content?: DocsStructuralElement[];
}

export interface DocsNamedRangeEntry {
  namedRangeId?: string;
  ranges?: { startIndex?: number; endIndex?: number; tabId?: string }[];
}

export interface DocsDocument {
  title?: string;
  documentId?: string;
  revisionId?: string;
  suggestionsViewMode?: string;
  body?: { content?: DocsStructuralElement[] };
  tabs?: DocsTab[];
  documentStyle?: DocsDocumentStyle;
  headers?: Record<string, DocsHeaderFooterSegment>;
  footers?: Record<string, DocsHeaderFooterSegment>;
  namedRanges?: Record<string, { namedRanges?: DocsNamedRangeEntry[] }>;
}

export interface DocsBatchUpdateResponse {
  replies?: Array<{
    replaceAllText?: { occurrencesChanged?: number };
    createHeader?: { headerId?: string };
    createFooter?: { footerId?: string };
    createNamedRange?: { namedRangeId?: string };
    createFootnote?: { footnoteId?: string };
    insertInlineImage?: { objectId?: string };
    addDocumentTab?: { tabProperties?: DocsTabProperties };
  }>;
}

// ── Google Drive ─────────────────────────────────────────────────────────────

export interface DriveFileSearchResult {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  webContentLink?: string;
  description?: string;
  owners?: { emailAddress?: string; displayName?: string }[];
  parents?: string[];
}

export interface DriveFileListResponse {
  files?: DriveFileSearchResult[];
  nextPageToken?: string;
}

export interface DriveComment {
  id?: string;
  author?: { displayName?: string };
  content?: string;
  createdTime?: string;
  resolved?: boolean;
  replies?: unknown[];
}

export interface DriveCommentListResponse {
  comments?: DriveComment[];
}

export interface DrivePermission {
  id?: string;
  role?: string;
  type?: string;
  emailAddress?: string;
  displayName?: string;
}

export interface DrivePermissionListResponse {
  permissions?: DrivePermission[];
}

export interface DriveRevision {
  id?: string;
  modifiedTime?: string;
  lastModifyingUser?: { emailAddress?: string; displayName?: string };
  size?: string;
  keepForever?: boolean;
  published?: boolean;
  publishAuto?: boolean;
  mimeType?: string;
  exportLinks?: Record<string, string>;
  webContentLink?: string;
}

export interface DriveRevisionListResponse {
  revisions?: DriveRevision[];
  nextPageToken?: string;
}

// ── Google Apps Script ───────────────────────────────────────────────────────

export interface ScriptFile {
  id?: string;
  name?: string;
  type?: string;
  source?: string;
}

export interface ScriptProjectContent {
  scriptId?: string;
  files?: ScriptFile[];
}

export interface ScriptProject {
  scriptId?: string;
  title?: string;
}

export interface ScriptExecutionError {
  errorMessage?: string;
  errorType?: string;
  scriptStackTraceElements?: unknown[];
}

export interface ScriptRunResponse {
  error?: { code?: number; message?: string; details?: ScriptExecutionError[] };
  response?: { result?: unknown };
  done?: boolean;
}

export interface ScriptDeploymentConfig {
  scriptId?: string;
  versionNumber?: number;
  manifestFileName?: string;
  description?: string;
  access?: string;
}

export interface ScriptDeployment {
  deploymentId?: string;
  deploymentConfig?: ScriptDeploymentConfig;
  updateTime?: string;
}

export interface ScriptDeploymentListResponse {
  deployments?: ScriptDeployment[];
}

export interface ScriptVersion {
  scriptId?: string;
  versionNumber?: number;
  description?: string;
  createTime?: string;
}

export interface ScriptVersionListResponse {
  versions?: ScriptVersion[];
}

export interface ScriptProcess {
  functionName?: string;
  processStatus?: string;
  processType?: string;
  startTime?: string;
  duration?: string;
}

export interface ScriptProcessListResponse {
  processes?: ScriptProcess[];
}

export interface ScriptMetrics {
  activeUsers?: unknown[];
  failedExecutions?: unknown[];
  totalExecutions?: unknown[];
}

export interface ScriptTrigger {
  triggerId?: string;
  functionName?: string;
  eventType?: string;
  triggerSource?: string;
}

export interface ScriptTriggerListResponse {
  triggers?: ScriptTrigger[];
}

// ── Google Sheets ─────────────────────────────────────────────────────────────

export interface SheetGridProperties {
  rowCount?: number;
  columnCount?: number;
}

export interface SheetProperties {
  sheetId?: number;
  title?: string;
  index?: number;
  gridProperties?: SheetGridProperties;
}

export interface SheetChart {
  chartId?: number;
  spec?: { basicChart?: { chartType?: string }; pieChart?: unknown; title?: string };
}

export interface SheetInfo {
  properties?: SheetProperties;
  charts?: SheetChart[];
  bandedRanges?: { bandedRangeId?: number }[];
}

export interface Spreadsheet {
  spreadsheetId?: string;
  properties?: { title?: string };
  sheets?: SheetInfo[];
}

export interface SheetValuesResponse {
  range?: string;
  majorDimension?: string;
  values?: (string | number | boolean | null)[][];
}

export interface SheetValuesUpdateResponse {
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
}

export interface SheetValuesAppendResponse {
  updates?: { updatedRows?: number; updatedCells?: number };
}

export interface SheetCellData {
  formattedValue?: string;
  note?: string;
}

export interface SheetRowData {
  values?: SheetCellData[];
}

export interface SheetGridData {
  rowData?: SheetRowData[];
}

export interface SheetWithGridData {
  data?: SheetGridData[];
}

export interface SpreadsheetWithGridData {
  sheets?: SheetWithGridData[];
}

export interface SheetsBatchUpdateResponse {
  spreadsheetId?: string;
  replies?: Array<{
    addSheet?: { properties?: SheetProperties };
    addChart?: { chart?: { chartId?: number } };
    addFilterView?: { filter?: { filterViewId?: number } };
    addProtectedRange?: { protectedRange?: { protectedRangeId?: number } };
  }>;
}
