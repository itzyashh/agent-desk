import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const Route = createFileRoute("/")({
  component: ChatPage,
});

type SheetTab = {
  gid: string;
  title: string;
};

type SheetLink = {
  url: string;
  spreadsheetId: string;
  gid?: string;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  kind?: "text" | "google-connect" | "sheet-picker";
  sheet?: SheetLink;
  tabs?: SheetTab[];
};

type ChatApiResponse = {
  reply: string;
  conversation_name?: string | null;
  needs_location?: boolean;
  tokens_used?: number | null;
  tokens_remaining?: number | null;
  daily_token_budget?: number | null;
};

type QuotaInfo = {
  tokensUsed: number;
  tokensRemaining: number;
  dailyTokenBudget: number;
};

type ChatRequestBody = {
  message: string;
  thread_id: string;
  new?: boolean;
  latitude?: number;
  longitude?: number;
  spreadsheet_id?: string;
  gid?: string;
};

class ChatApiError extends Error {
  status: number;
  quota?: QuotaInfo;

  constructor(message: string, status: number, quota?: QuotaInfo) {
    super(message);
    this.name = "ChatApiError";
    this.status = status;
    this.quota = quota;
  }
}

type Conversation = {
  id: string;
  threadId: string;
  title: string;
  messages: Message[];
  updatedAt: number;
  spreadsheetId?: string | null;
  gid?: string | null;
  tabTitle?: string | null;
};

type PendingSheetPayload = {
  sheet: SheetLink;
  conversationId?: string;
};

type SendMessageOptions = {
  conversationId?: string;
  spreadsheetId?: string | null;
  gid?: string | null;
};

const SUGGESTIONS = [
  "What can you help me with?",
  "How is the weather today?",
  "Where am I located?",
];

const STORAGE_KEY = "agent-suite-conversations";
const DEVICE_ID_KEY = "agent-suite-device-id";
const GOOGLE_CONNECTED_KEY = "agent-suite-google-connected";
const PENDING_SHEET_KEY = "agent-suite-pending-sheet";
const GOOGLE_LOGO_SRC = "https://img.icons8.com/?id=17949&format=png&size=48";
const SHEETS_ICON_SRC = "https://img.icons8.com/?id=30461&format=png&size=48";
const SHEET_URL_RE =
  /https?:\/\/docs\.google\.com\/spreadsheets\/d\/(?!e\/)([a-zA-Z0-9-_]{20,})/i;
const APP_NAME = "Agent Suite";
const ASSISTANT_NAME = "Agent";
const ASSISTANT_AVATAR = "A";

const API_BASE = resolveApiBase();

function resolveApiBase(): string {
  const configured = String(import.meta.env.VITE_API_URL ?? "")
    .trim()
    .replace(/\/$/, "");
  const productionFallback = "https://agent-desk.onrender.com";
  const localFallback = "http://localhost:8000";

  if (!import.meta.env.PROD) {
    return configured || localFallback;
  }

  // Hosted builds sometimes inherit a localhost VITE_API_URL from the
  // deploy console; never ship that to real browsers.
  if (
    !configured ||
    /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configured)
  ) {
    return productionFallback;
  }

  return configured;
}

function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") return crypto.randomUUID();

  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;

  const id = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

function isGoogleConnected(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(GOOGLE_CONNECTED_KEY) === "true";
}

function persistGoogleConnected(connected: boolean) {
  if (typeof window === "undefined") return;
  if (connected) localStorage.setItem(GOOGLE_CONNECTED_KEY, "true");
  else localStorage.removeItem(GOOGLE_CONNECTED_KEY);
}

type GoogleStatus = {
  connected: boolean;
};

async function fetchGoogleStatus(): Promise<GoogleStatus> {
  try {
    const res = await fetch(`${API_BASE}/auth/google/status`, {
      headers: { "X-Device-Id": getOrCreateDeviceId() },
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || typeof payload !== "object") {
      return { connected: false };
    }
    return { connected: (payload as { connected?: unknown }).connected === true };
  } catch {
    return { connected: false };
  }
}

async function fetchSheetTabs(spreadsheetId: string): Promise<SheetTab[]> {
  const res = await fetch(
    `${API_BASE}/auth/google/tabs?spreadsheet_id=${encodeURIComponent(spreadsheetId)}`,
    { headers: { "X-Device-Id": getOrCreateDeviceId() } },
  );
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload || typeof payload !== "object") return [];
  const tabs = (payload as { tabs?: unknown }).tabs;
  if (!Array.isArray(tabs)) return [];
  return tabs.filter(
    (tab): tab is SheetTab =>
      !!tab &&
      typeof tab === "object" &&
      typeof (tab as SheetTab).gid === "string" &&
      typeof (tab as SheetTab).title === "string",
  );
}

function sheetUrlWithGid(spreadsheetId: string, gid: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}#gid=${gid}`;
}

function apiOrigin(): string {
  try {
    return new URL(API_BASE).origin;
  } catch {
    return "";
  }
}

function parseGoogleSheetLink(text: string): SheetLink | null {
  const match = text.match(SHEET_URL_RE);
  if (!match) return null;

  const spreadsheetId = match[1];
  const url = match[0];
  const gidMatch = text.match(/[?&#]gid=(\d+)/);

  return {
    url,
    spreadsheetId,
    gid: gidMatch?.[1],
  };
}

function isSheetLinkOnly(text: string, sheet: SheetLink): boolean {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (trimmed === sheet.url || trimmed.startsWith(sheet.url)) return true;

  try {
    const parsed = new URL(trimmed);
    return (
      parsed.hostname === "docs.google.com" &&
      parsed.pathname.includes(`/spreadsheets/d/${sheet.spreadsheetId}`)
    );
  } catch {
    return false;
  }
}

function storePendingSheet(sheet: SheetLink, conversationId?: string) {
  if (typeof window === "undefined") return;
  const payload: PendingSheetPayload = { sheet, conversationId };
  sessionStorage.setItem(PENDING_SHEET_KEY, JSON.stringify(payload));
}

function takePendingSheet(): PendingSheetPayload | null {
  if (typeof window === "undefined") return null;
  const pendingRaw = sessionStorage.getItem(PENDING_SHEET_KEY);
  sessionStorage.removeItem(PENDING_SHEET_KEY);
  if (!pendingRaw) return null;
  try {
    const parsed = JSON.parse(pendingRaw) as Record<string, unknown>;
    if (
      parsed.sheet &&
      typeof parsed.sheet === "object" &&
      typeof (parsed.sheet as SheetLink).spreadsheetId === "string"
    ) {
      return {
        sheet: parsed.sheet as SheetLink,
        conversationId:
          typeof parsed.conversationId === "string"
            ? parsed.conversationId
            : undefined,
      };
    }
    if (typeof parsed.spreadsheetId === "string") {
      return { sheet: parsed as unknown as SheetLink };
    }
  } catch {
    return null;
  }
  return null;
}

function inferLinkedSheet(messages: Message[]): {
  spreadsheetId?: string;
  gid?: string;
  tabTitle?: string;
} {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const parsed = parseGoogleSheetLink(msg.content);
    if (parsed) {
      return {
        spreadsheetId: parsed.spreadsheetId,
        gid: parsed.gid,
      };
    }
  }
  return {};
}

function beginGoogleConnect(sheet: SheetLink, conversationId?: string) {
  if (typeof window === "undefined") return;
  storePendingSheet(sheet, conversationId);
  const params = new URLSearchParams({
    device_id: getOrCreateDeviceId(),
    spreadsheet_id: sheet.spreadsheetId,
  });
  const url = `${API_BASE}/auth/google/start?${params.toString()}`;
  const popup = window.open(
    url,
    "google-connect",
    "popup=yes,width=520,height=720",
  );
  if (!popup) {
    window.location.assign(url);
  }
}

function GoogleConnectCard({
  sheet,
  onConnect,
  onDismiss,
  compact = false,
}: {
  sheet: SheetLink;
  onConnect: () => void;
  onDismiss?: () => void;
  compact?: boolean;
}) {
  const shortId =
    sheet.spreadsheetId.length > 18
      ? `${sheet.spreadsheetId.slice(0, 10)}…${sheet.spreadsheetId.slice(-6)}`
      : sheet.spreadsheetId;

  return (
    <div className={`connector-card${compact ? " connector-card-compact" : ""}`}>
      <div className="connector-card-top">
        <img
          className="connector-card-icon"
          src={SHEETS_ICON_SRC}
          alt=""
          width={compact ? 22 : 28}
          height={compact ? 22 : 28}
        />
        <div className="connector-card-copy">
          <div className="connector-card-title">Please connect with Google</div>
          <p className="connector-card-body">
            {compact
              ? "Connect your Google account to use this sheet in chat."
              : "I found a Google Sheet. Connect your Google account so I can read and update it from this chat."}
          </p>
          <a
            className="connector-card-sheet"
            href={sheet.url}
            target="_blank"
            rel="noreferrer"
          >
            {shortId}
          </a>
        </div>
        {onDismiss && (
          <button
            type="button"
            className="connector-dismiss"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            ×
          </button>
        )}
      </div>
      <button type="button" className="google-connect-btn" onClick={onConnect}>
        <img src={GOOGLE_LOGO_SRC} alt="" width={18} height={18} />
        Connect with Google
      </button>
    </div>
  );
}

function SheetPickerCard({
  tabs,
  selectedGid,
  onSelect,
  onDismiss,
  compact = false,
}: {
  tabs: SheetTab[];
  selectedGid?: string | null;
  onSelect: (tab: SheetTab) => void;
  onDismiss?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={`connector-card${compact ? " connector-card-compact" : ""}`}>
      <div className="connector-card-top">
        <img
          className="connector-card-icon"
          src={SHEETS_ICON_SRC}
          alt=""
          width={compact ? 22 : 28}
          height={compact ? 22 : 28}
        />
        <div className="connector-card-copy">
          <div className="connector-card-title">Choose a sheet tab</div>
          <p className="connector-card-body">
            This spreadsheet has {tabs.length} tabs. Pick which one to use in
            chat.
          </p>
        </div>
        {onDismiss && (
          <button
            type="button"
            className="connector-dismiss"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            ×
          </button>
        )}
      </div>
      <div className="sheet-tab-list">
        {tabs.map((tab) => (
          <button
            key={tab.gid}
            type="button"
            className={`sheet-tab-btn${selectedGid === tab.gid ? " selected" : ""}`}
            onClick={() => onSelect(tab)}
          >
            {tab.title}
          </button>
        ))}
      </div>
    </div>
  );
}

function quotaFromPayload(payload: unknown): QuotaInfo | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const data = payload as Record<string, unknown>;
  const tokensUsed = data.tokens_used;
  const tokensRemaining = data.tokens_remaining;
  const dailyTokenBudget = data.daily_token_budget;
  if (
    typeof tokensUsed !== "number" ||
    typeof tokensRemaining !== "number" ||
    typeof dailyTokenBudget !== "number"
  ) {
    return undefined;
  }
  return {
    tokensUsed,
    tokensRemaining,
    dailyTokenBudget,
  };
}

function formatTokenCount(n: number): string {
  return n.toLocaleString();
}

type StoredChatState = {
  conversations: Conversation[];
  activeId: string;
};

function normalizeConversation(raw: Conversation): Conversation {
  const inferred = raw.spreadsheetId ? {} : inferLinkedSheet(raw.messages ?? []);
  return {
    ...raw,
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    spreadsheetId: raw.spreadsheetId ?? inferred.spreadsheetId ?? null,
    gid: raw.gid ?? inferred.gid ?? null,
    tabTitle: raw.tabTitle ?? inferred.tabTitle ?? null,
  };
}

function loadStoredState(): StoredChatState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as StoredChatState;
    if (!Array.isArray(parsed.conversations) || parsed.conversations.length === 0) {
      return null;
    }

    const conversations = parsed.conversations.map(normalizeConversation);
    const activeExists = conversations.some((c) => c.id === parsed.activeId);
    return {
      conversations,
      activeId: activeExists ? parsed.activeId : conversations[0].id,
    };
  } catch {
    return null;
  }
}

function saveStoredState(state: StoredChatState) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function createConversation(title = "New chat"): Conversation {
  const id = crypto.randomUUID();
  return {
    id,
    threadId: id,
    title,
    messages: [],
    updatedAt: Date.now(),
  };
}

async function postChat(body: ChatRequestBody): Promise<ChatApiResponse> {
  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Id": getOrCreateDeviceId(),
    },
    body: JSON.stringify(body),
  });

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    const detail =
      payload && typeof payload === "object"
        ? (payload as { detail?: unknown }).detail
        : undefined;
    const detailObj =
      detail && typeof detail === "object"
        ? (detail as Record<string, unknown>)
        : null;
    const message =
      (typeof detailObj?.message === "string" && detailObj.message) ||
      (typeof detail === "string" && detail) ||
      "Request failed";
    const quota = quotaFromPayload(detailObj ?? payload);
    throw new ChatApiError(message, res.status, quota);
  }

  return payload as ChatApiResponse;
}

function requestBrowserLocation(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported"));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      (error) => reject(error),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 60_000 },
    );
  });
}

function StreamingTitle({
  text,
  animate,
  onComplete,
  className,
}: {
  text: string;
  animate: boolean;
  onComplete?: () => void;
  className?: string;
}) {
  const [displayed, setDisplayed] = useState(animate ? "" : text);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!animate) {
      setDisplayed(text);
      return;
    }

    setDisplayed("");
    let index = 0;
    let timer: ReturnType<typeof setTimeout>;

    const step = () => {
      index += 1;
      setDisplayed(text.slice(0, index));
      if (index < text.length) {
        timer = setTimeout(step, 32);
      } else {
        onCompleteRef.current?.();
      }
    };

    timer = setTimeout(step, 32);
    return () => clearTimeout(timer);
  }, [text, animate]);

  const streaming = animate && displayed.length < text.length;

  return (
    <span className={className}>
      {displayed}
      {streaming && <span className="title-stream-cursor" aria-hidden="true" />}
    </span>
  );
}

function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [pendingComposerSheet, setPendingComposerSheet] =
    useState<SheetLink | null>(null);
  const [pendingTabs, setPendingTabs] = useState<SheetTab[]>([]);
  const [googleConnected, setGoogleConnected] = useState(false);
  const sendMessageRef = useRef<
    (text: string, options?: SendMessageOptions) => Promise<void>
  >(async () => undefined);
  const pickOrSendSheetRef = useRef<
    (
      sheet: SheetLink,
      userMessage?: string,
      conversationId?: string,
    ) => Promise<void>
  >(async () => undefined);
  const [animatingTitleIds, setAnimatingTitleIds] = useState<Set<string>>(
    () => new Set(),
  );
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function applyQuotaFromResponse(data: ChatApiResponse) {
    const next = quotaFromPayload(data);
    if (next) setQuota(next);
  }

  useEffect(() => {
    const stored = loadStoredState();
    if (stored) {
      setConversations(stored.conversations);
      setActiveId(stored.activeId);
    } else {
      const fresh = createConversation();
      setConversations([fresh]);
      setActiveId(fresh.id);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function hydrateGoogle() {
      const status = await fetchGoogleStatus();
      if (cancelled) return;
      persistGoogleConnected(status.connected);
      setGoogleConnected(status.connected);

      const params = new URLSearchParams(window.location.search);
      if (params.get("google") === "connected") {
        params.delete("google");
        params.delete("spreadsheet_id");
        const next = params.toString();
        const path = `${window.location.pathname}${next ? `?${next}` : ""}${window.location.hash}`;
        window.history.replaceState({}, "", path);
        const pending = takePendingSheet();
        if (status.connected && pending) {
          await pickOrSendSheetRef.current(
            pending.sheet,
            undefined,
            pending.conversationId,
          );
        }
      }
    }

    void hydrateGoogle();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== apiOrigin()) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if ((data as { type?: string }).type !== "google-connected") return;

      void (async () => {
        const status = await fetchGoogleStatus();
        persistGoogleConnected(status.connected);
        setGoogleConnected(status.connected);
        const pending = takePendingSheet();
        if (status.connected && pending) {
          await pickOrSendSheetRef.current(
            pending.sheet,
            undefined,
            pending.conversationId,
          );
        }
      })();
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!ready || conversations.length === 0) return;
    saveStoredState({ conversations, activeId });
  }, [conversations, activeId, ready]);

  const activeConversation =
    conversations.find((c) => c.id === activeId) ?? conversations[0];
  const messages = activeConversation?.messages ?? [];
  const linkedSpreadsheetId = activeConversation?.spreadsheetId ?? null;
  const linkedGid = activeConversation?.gid ?? null;
  const linkedTabTitle = activeConversation?.tabTitle ?? null;

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [messages, loading, activeId]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [input, activeId]);

  useEffect(() => {
    if (
      !googleConnected ||
      !activeConversation?.spreadsheetId ||
      activeConversation.tabTitle
    ) {
      return;
    }
    const conversationId = activeConversation.id;
    const spreadsheetId = activeConversation.spreadsheetId;
    const gid = activeConversation.gid;
    let cancelled = false;
    void (async () => {
      const tabs = await fetchSheetTabs(spreadsheetId);
      if (cancelled || !tabs.length) return;
      const title =
        tabs.find((tab) => tab.gid === gid)?.title ?? tabs[0]?.title ?? null;
      if (!title) return;
      setConversations((prev) =>
        prev.map((c) => {
          if (
            c.id !== conversationId ||
            c.tabTitle ||
            c.spreadsheetId !== spreadsheetId
          ) {
            return c;
          }
          return {
            ...c,
            gid: c.gid ?? gid ?? tabs[0].gid,
            tabTitle: title,
          };
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [
    googleConnected,
    activeConversation?.id,
    activeConversation?.spreadsheetId,
    activeConversation?.gid,
    activeConversation?.tabTitle,
  ]);

  function clearTitleAnimation(id: string) {
    setAnimatingTitleIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function updateConversation(
    id: string,
    updater: (conversation: Conversation) => Conversation,
  ) {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? updater(c) : c)),
    );
  }

  function startNewChat() {
    const conversation = createConversation();
    setConversations((prev) => [conversation, ...prev]);
    setActiveId(conversation.id);
    setInput("");
    setPendingComposerSheet(null);
    setPendingTabs([]);
    setSidebarOpen(false);
  }

  function selectConversation(id: string) {
    setActiveId(id);
    setInput("");
    setPendingComposerSheet(null);
    setPendingTabs([]);
    setSidebarOpen(false);
  }

  function deleteConversation(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (id === activeId) {
      setPendingComposerSheet(null);
      setPendingTabs([]);
    }
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (next.length === 0) {
        const fresh = createConversation();
        setActiveId(fresh.id);
        return [fresh];
      }
      if (activeId === id) {
        setActiveId(next[0].id);
      }
      return next;
    });
  }

  function attachSheetToConversation(
    conversationId: string,
    sheet: {
      spreadsheetId: string;
      gid?: string | null;
      tabTitle?: string | null;
    },
  ) {
    updateConversation(conversationId, (c) => ({
      ...c,
      spreadsheetId: sheet.spreadsheetId,
      gid: sheet.gid ?? null,
      tabTitle: sheet.tabTitle ?? null,
      updatedAt: Date.now(),
    }));
  }

  function showSheetConnectPrompt(
    sheet: SheetLink,
    userMessage?: string,
    conversationId?: string,
  ) {
    const target =
      (conversationId
        ? conversations.find((c) => c.id === conversationId)
        : null) ?? activeConversation;
    if (!target) return;

    const targetId = target.id;
    const isFirstMessage = target.messages.length === 0;

    if (isFirstMessage) {
      setAnimatingTitleIds((prev) => new Set(prev).add(targetId));
    }

    updateConversation(targetId, (c) => {
      const alreadyPrompted = c.messages.some(
        (m) =>
          m.kind === "google-connect" &&
          m.sheet?.spreadsheetId === sheet.spreadsheetId,
      );
      const nextMessages = [...c.messages];

      if (userMessage) {
        const last = nextMessages[nextMessages.length - 1];
        const lastWasSame =
          last?.role === "user" && last.content.trim() === userMessage.trim();
        if (!lastWasSame) {
          nextMessages.push({ role: "user", content: userMessage });
        }
      }

      if (!alreadyPrompted) {
        nextMessages.push({
          role: "assistant",
          kind: "google-connect",
          content: "Please connect with Google to work with this spreadsheet.",
          sheet,
        });
      }

      return {
        ...c,
        title: isFirstMessage ? "Google Sheet" : c.title,
        updatedAt: Date.now(),
        messages: nextMessages,
      };
    });
  }

  function showSheetPickerPrompt(
    sheet: SheetLink,
    tabs: SheetTab[],
    userMessage?: string,
    conversationId?: string,
  ) {
    const target =
      (conversationId
        ? conversations.find((c) => c.id === conversationId)
        : null) ?? activeConversation;
    if (!target) return;

    const targetId = target.id;
    const isFirstMessage = target.messages.length === 0;

    if (isFirstMessage) {
      setAnimatingTitleIds((prev) => new Set(prev).add(targetId));
    }

    updateConversation(targetId, (c) => {
      const alreadyPrompted = c.messages.some(
        (m) =>
          m.kind === "sheet-picker" &&
          m.sheet?.spreadsheetId === sheet.spreadsheetId,
      );
      const nextMessages = [...c.messages];

      if (userMessage) {
        const last = nextMessages[nextMessages.length - 1];
        const lastWasSame =
          last?.role === "user" && last.content.trim() === userMessage.trim();
        if (!lastWasSame) {
          nextMessages.push({ role: "user", content: userMessage });
        }
      }

      if (!alreadyPrompted) {
        nextMessages.push({
          role: "assistant",
          kind: "sheet-picker",
          content: "Choose a sheet tab to continue.",
          sheet,
          tabs,
        });
      }

      return {
        ...c,
        title: isFirstMessage ? "Google Sheet" : c.title,
        updatedAt: Date.now(),
        messages: nextMessages,
      };
    });
  }

  async function pickOrSendSheet(
    sheet: SheetLink,
    userMessage?: string,
    conversationId?: string,
  ) {
    const targetId = conversationId || activeConversation?.id;
    if (!targetId) return;

    if (conversationId && conversationId !== activeId) {
      setActiveId(conversationId);
    }

    const tabs = await fetchSheetTabs(sheet.spreadsheetId);
    if (sheet.gid || tabs.length <= 1) {
      const gid = sheet.gid ?? tabs[0]?.gid;
      const title = tabs.find((tab) => tab.gid === gid)?.title ?? null;
      attachSheetToConversation(targetId, {
        spreadsheetId: sheet.spreadsheetId,
        gid,
        tabTitle: title,
      });
      setPendingComposerSheet(null);
      setPendingTabs([]);
      await sendMessageRef.current(userMessage ?? sheet.url, {
        conversationId: targetId,
        spreadsheetId: sheet.spreadsheetId,
        gid,
      });
      return;
    }

    setPendingComposerSheet(sheet);
    setPendingTabs(tabs);
    showSheetPickerPrompt(sheet, tabs, userMessage, targetId);
  }

  async function selectSheetTab(sheet: SheetLink, tab: SheetTab) {
    const targetId = activeConversation?.id;
    if (!targetId) return;
    attachSheetToConversation(targetId, {
      spreadsheetId: sheet.spreadsheetId,
      gid: tab.gid,
      tabTitle: tab.title,
    });
    setPendingComposerSheet(null);
    setPendingTabs([]);
    persistGoogleConnected(true);
    await sendMessageRef.current(sheetUrlWithGid(sheet.spreadsheetId, tab.gid), {
      conversationId: targetId,
      spreadsheetId: sheet.spreadsheetId,
      gid: tab.gid,
    });
  }

  pickOrSendSheetRef.current = pickOrSendSheet;

  async function sendMessage(text: string, options?: SendMessageOptions) {
    const userMessage = text.trim();
    if (!userMessage || loading) return;
    if (quota && quota.tokensRemaining <= 0) return;

    const conversation =
      (options?.conversationId
        ? conversations.find((c) => c.id === options.conversationId)
        : null) ?? activeConversation;
    if (!conversation) return;

    const conversationId = conversation.id;
    const threadId = conversation.threadId;
    const isFirstMessage = conversation.messages.length === 0;
    let spreadsheetId =
      options?.spreadsheetId ?? conversation.spreadsheetId ?? undefined;
    let gid = options?.gid ?? conversation.gid ?? undefined;

    const sheet = parseGoogleSheetLink(userMessage);
    if (sheet && !isGoogleConnected()) {
      const caughtInComposer =
        pendingComposerSheet?.spreadsheetId === sheet.spreadsheetId;
      if (!caughtInComposer) {
        setInput("");
        showSheetConnectPrompt(sheet, userMessage, conversationId);
        return;
      }
      if (isSheetLinkOnly(userMessage, sheet)) {
        return;
      }
    }

    if (sheet && isGoogleConnected()) {
      const resolvedGid = sheet.gid ?? options?.gid ?? undefined;
      const tabs = pendingTabs.length
        ? pendingTabs
        : await fetchSheetTabs(sheet.spreadsheetId);
      if (!resolvedGid && tabs.length > 1) {
        setInput("");
        setPendingComposerSheet(sheet);
        setPendingTabs(tabs);
        showSheetPickerPrompt(sheet, tabs, userMessage, conversationId);
        return;
      }
      const nextGid = resolvedGid ?? tabs[0]?.gid;
      attachSheetToConversation(conversationId, {
        spreadsheetId: sheet.spreadsheetId,
        gid: nextGid,
        tabTitle: tabs.find((tab) => tab.gid === nextGid)?.title ?? null,
      });
      spreadsheetId = sheet.spreadsheetId;
      gid = nextGid;
      setPendingComposerSheet(null);
      setPendingTabs([]);
    }

    setInput("");

    updateConversation(conversationId, (c) => ({
      ...c,
      updatedAt: Date.now(),
      messages: [...c.messages, { role: "user", content: userMessage }],
    }));

    setLoading(true);

    try {
      let data = await postChat({
        message: userMessage,
        thread_id: threadId,
        new: isFirstMessage,
        spreadsheet_id: spreadsheetId,
        gid,
      });
      applyQuotaFromResponse(data);

      if (data.needs_location) {
        try {
          const coords = await requestBrowserLocation();
          data = await postChat({
            message:
              "Device location is available. Continue answering the previous request using these coordinates.",
            thread_id: threadId,
            new: false,
            latitude: coords.latitude,
            longitude: coords.longitude,
            spreadsheet_id: spreadsheetId,
            gid,
          });
          applyQuotaFromResponse(data);
        } catch (error) {
          if (error instanceof ChatApiError && error.status === 429) {
            if (error.quota) setQuota(error.quota);
            updateConversation(conversationId, (c) => ({
              ...c,
              updatedAt: Date.now(),
              messages: [
                ...c.messages,
                {
                  role: "assistant",
                  content:
                    error.message ||
                    "Daily token budget reached. Try again tomorrow.",
                },
              ],
            }));
            return;
          }
          updateConversation(conversationId, (c) => ({
            ...c,
            updatedAt: Date.now(),
            messages: [
              ...c.messages,
              {
                role: "assistant",
                content:
                  "Location access is required for this. Please allow location permission and try again.",
              },
            ],
          }));
          return;
        }
      }

      if (data.needs_location) {
        updateConversation(conversationId, (c) => ({
          ...c,
          updatedAt: Date.now(),
          messages: [
            ...c.messages,
            {
              role: "assistant",
              content:
                "Location access is required for this. Please allow location permission and try again.",
            },
          ],
        }));
        return;
      }

      const fallbackTitle =
        userMessage.slice(0, 36) + (userMessage.length > 36 ? "…" : "");
      const newTitle =
        data.conversation_name ??
        (isFirstMessage ? fallbackTitle : conversation.title);

      if (isFirstMessage && newTitle !== conversation.title) {
        setAnimatingTitleIds((prev) => new Set(prev).add(conversationId));
      }

      updateConversation(conversationId, (c) => ({
        ...c,
        title: newTitle,
        updatedAt: Date.now(),
        messages: [...c.messages, { role: "assistant", content: data.reply }],
      }));
    } catch (error) {
      if (error instanceof ChatApiError) {
        if (error.quota) setQuota(error.quota);
        updateConversation(conversationId, (c) => ({
          ...c,
          updatedAt: Date.now(),
          messages: [
            ...c.messages,
            {
              role: "assistant",
              content:
                error.status === 429
                  ? error.message ||
                    "Daily token budget reached. Try again tomorrow."
                  : error.message ||
                    "Something went wrong. Please try again.",
            },
          ],
        }));
      } else {
        updateConversation(conversationId, (c) => ({
          ...c,
          updatedAt: Date.now(),
          messages: [
            ...c.messages,
            {
              role: "assistant",
              content:
                "Something went wrong. Make sure the backend is running on port 8000.",
            },
          ],
        }));
      }
    } finally {
      setLoading(false);
    }
  }

  sendMessageRef.current = sendMessage;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    sendMessage(input);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = e.clipboardData.getData("text");
    const sheet = parseGoogleSheetLink(pasted);
    if (!sheet) return;

    if (!isGoogleConnected()) {
      setPendingComposerSheet(sheet);
      if (isSheetLinkOnly(pasted, sheet) && !input.trim()) {
        e.preventDefault();
        setInput("");
      }
      return;
    }

    if (isSheetLinkOnly(pasted, sheet) && !input.trim()) {
      e.preventDefault();
      setInput("");
      void pickOrSendSheet(sheet, pasted.trim());
    }
  }

  const sortedConversations = [...conversations].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const isEmpty = messages.length === 0 && !loading;
  const quotaExhausted = Boolean(quota && quota.tokensRemaining <= 0);
  const inputDisabled = loading || quotaExhausted;

  if (!ready) {
    return null;
  }

  return (
    <div className="chat-layout">
      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <button type="button" className="new-chat-btn" onClick={startNewChat}>
            <span className="new-chat-icon">+</span>
            New chat
          </button>
        </div>

        <div className="sidebar-label">Chats</div>
        <nav className="conversation-list">
          {sortedConversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={`conversation-item ${conversation.id === activeId ? "active" : ""}`}
              onClick={() => selectConversation(conversation.id)}
            >
              <StreamingTitle
                text={conversation.title}
                animate={animatingTitleIds.has(conversation.id)}
                onComplete={() => clearTitleAnimation(conversation.id)}
                className="conversation-title"
              />
              <span
                role="button"
                tabIndex={0}
                className="conversation-delete"
                aria-label="Delete chat"
                onClick={(e) => deleteConversation(conversation.id, e)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    deleteConversation(conversation.id, e as unknown as React.MouseEvent);
                  }
                }}
              >
                ×
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="chat-main">
        <div className="chat-app">
          <header className="chat-header">
            <button
              type="button"
              className="sidebar-toggle"
              aria-label="Open conversations"
              onClick={() => setSidebarOpen(true)}
            >
              ☰
            </button>
            <div className="chat-header-icon">{ASSISTANT_AVATAR}</div>
            <span className="chat-header-title">
              {activeConversation?.title ?? APP_NAME}
            </span>
          </header>

          <div className="chat-messages" ref={messagesContainerRef}>
            {isEmpty ? (
              <div className="chat-empty">
                <div className="chat-empty-icon">{ASSISTANT_AVATAR}</div>
                <h2>How can I help you today?</h2>
                <p>
                  Ask anything — or paste a Google Sheet link to connect it.
                </p>
                <div className="chat-suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="chat-suggestion"
                      onClick={() => sendMessage(suggestion)}
                      disabled={inputDisabled}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {messages.map((msg, i) => (
                  <article key={i} className="message">
                    <div className={`message-avatar ${msg.role}`}>
                      {msg.role === "user" ? "Y" : ASSISTANT_AVATAR}
                    </div>
                    <div className="message-body">
                      <div className="message-label">
                        {msg.role === "user" ? "You" : ASSISTANT_NAME}
                      </div>
                      {msg.kind === "google-connect" && msg.sheet ? (
                        <GoogleConnectCard
                          sheet={msg.sheet}
                          onConnect={() =>
                            beginGoogleConnect(
                              msg.sheet!,
                              activeConversation?.id,
                            )
                          }
                        />
                      ) : msg.kind === "sheet-picker" && msg.sheet && msg.tabs ? (
                        <SheetPickerCard
                          tabs={msg.tabs}
                          selectedGid={linkedGid}
                          onSelect={(tab) => selectSheetTab(msg.sheet!, tab)}
                        />
                      ) : msg.role === "assistant" ? (
                        <div className="message-markdown">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              a: ({ href, children }) => (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {children}
                                </a>
                              ),
                            }}
                          >
                            {msg.content}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        msg.content
                      )}
                    </div>
                  </article>
                ))}
                {loading && (
                  <article className="message">
                    <div className="message-avatar assistant">{ASSISTANT_AVATAR}</div>
                    <div className="message-body">
                      <div className="message-label">{ASSISTANT_NAME}</div>
                      <div className="typing-indicator" aria-label="Thinking">
                        <span />
                        <span />
                        <span />
                      </div>
                    </div>
                  </article>
                )}
              </>
            )}
          </div>

          <div className="chat-input-area">
            <form onSubmit={handleSubmit}>
              <div className="chat-input-wrap">
                {pendingComposerSheet && !googleConnected && (
                  <GoogleConnectCard
                    compact
                    sheet={pendingComposerSheet}
                    onConnect={() =>
                      beginGoogleConnect(
                        pendingComposerSheet,
                        activeConversation?.id,
                      )
                    }
                    onDismiss={() => setPendingComposerSheet(null)}
                  />
                )}
                {pendingComposerSheet &&
                  googleConnected &&
                  pendingTabs.length > 1 &&
                  !pendingComposerSheet.gid && (
                    <SheetPickerCard
                      compact
                      tabs={pendingTabs}
                      selectedGid={linkedGid}
                      onSelect={(tab) =>
                        selectSheetTab(pendingComposerSheet, tab)
                      }
                      onDismiss={() => {
                        setPendingComposerSheet(null);
                        setPendingTabs([]);
                      }}
                    />
                  )}
                {googleConnected && linkedTabTitle && !pendingComposerSheet && (
                  <div className="sheet-tab-chip-row">
                    <span className="sheet-tab-chip">
                      Using <strong>{linkedTabTitle}</strong>
                    </span>
                    {linkedSpreadsheetId && (
                      <button
                        type="button"
                        className="sheet-tab-change"
                        onClick={() => {
                          void (async () => {
                            const tabs = await fetchSheetTabs(linkedSpreadsheetId);
                            if (!tabs.length) return;
                            const sheet: SheetLink = {
                              url: sheetUrlWithGid(
                                linkedSpreadsheetId,
                                linkedGid || tabs[0].gid,
                              ),
                              spreadsheetId: linkedSpreadsheetId,
                              gid: linkedGid ?? undefined,
                            };
                            setPendingComposerSheet(sheet);
                            setPendingTabs(tabs);
                            showSheetPickerPrompt(sheet, tabs);
                          })();
                        }}
                      >
                        Change tab
                      </button>
                    )}
                  </div>
                )}
                <div className="chat-input-row">
                  <textarea
                    ref={textareaRef}
                    className="chat-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    placeholder={
                      quotaExhausted
                        ? "Daily token limit reached"
                        : pendingComposerSheet && !googleConnected
                          ? "Add a message, or connect Google to use this sheet…"
                          : pendingComposerSheet && pendingTabs.length > 1
                            ? "Pick a tab above, or add a message…"
                            : `Message ${APP_NAME}...`
                    }
                    rows={1}
                    disabled={inputDisabled}
                  />
                  <button
                    type="submit"
                    className="chat-send"
                    disabled={inputDisabled || !input.trim()}
                    aria-label="Send message"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path
                        d="M12 2L12 14M12 2L6 8M12 2L18 8"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </form>
            <p
              className={`chat-footer-note${quotaExhausted ? " chat-footer-note-warn" : ""}`}
            >
              {quotaExhausted
                ? `Daily limit reached (${formatTokenCount(quota!.dailyTokenBudget)} tokens). Resets at UTC midnight.`
                : quota
                  ? `${formatTokenCount(quota.tokensRemaining)} / ${formatTokenCount(quota.dailyTokenBudget)} tokens left today · ${APP_NAME} can make mistakes.`
                  : `${APP_NAME} can make mistakes. Check important info.`}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
