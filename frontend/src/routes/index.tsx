import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: ChatPage,
});

type Message = { role: "user" | "assistant"; content: string };

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
};

const SUGGESTIONS = [
  "What can you help me with?",
  "How is the weather today?",
  "Where am I located?",
];

const STORAGE_KEY = "agent-suite-conversations";
const DEVICE_ID_KEY = "agent-suite-device-id";
const APP_NAME = "Agent Suite";
const ASSISTANT_NAME = "Agent";
const ASSISTANT_AVATAR = "A";

const API_BASE = (
  import.meta.env.VITE_API_URL ?? "http://localhost:8000"
).replace(/\/$/, "");

function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") return crypto.randomUUID();

  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;

  const id = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, id);
  return id;
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

function loadStoredState(): StoredChatState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as StoredChatState;
    if (!Array.isArray(parsed.conversations) || parsed.conversations.length === 0) {
      return null;
    }

    const activeExists = parsed.conversations.some((c) => c.id === parsed.activeId);
    return {
      conversations: parsed.conversations,
      activeId: activeExists ? parsed.activeId : parsed.conversations[0].id,
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
    if (!ready || conversations.length === 0) return;
    saveStoredState({ conversations, activeId });
  }, [conversations, activeId, ready]);

  const activeConversation =
    conversations.find((c) => c.id === activeId) ?? conversations[0];
  const messages = activeConversation?.messages ?? [];

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
    setSidebarOpen(false);
  }

  function selectConversation(id: string) {
    setActiveId(id);
    setInput("");
    setSidebarOpen(false);
  }

  function deleteConversation(id: string, e: React.MouseEvent) {
    e.stopPropagation();
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

  async function sendMessage(text: string) {
    const userMessage = text.trim();
    if (!userMessage || loading || !activeConversation) return;
    if (quota && quota.tokensRemaining <= 0) return;

    setInput("");

    const conversationId = activeConversation.id;
    const threadId = activeConversation.threadId;
    const isFirstMessage = activeConversation.messages.length === 0;

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
        (isFirstMessage ? fallbackTitle : activeConversation.title);

      if (isFirstMessage && newTitle !== activeConversation.title) {
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
                <p>Ask anything — weather, location, or general questions.</p>
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
                      {msg.content}
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
                <textarea
                  ref={textareaRef}
                  className="chat-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    quotaExhausted
                      ? "Daily token limit reached"
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
