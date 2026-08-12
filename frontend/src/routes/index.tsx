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
};

type ChatRequestBody = {
  message: string;
  thread_id: string;
  new?: boolean;
  latitude?: number;
  longitude?: number;
};

type Conversation = {
  id: string;
  threadId: string;
  title: string;
  messages: Message[];
  updatedAt: number;
};

const SUGGESTIONS = [
  "How is the weather today?",
  "What's the weather in Mumbai?",
  "Where am I located?",
];

const STORAGE_KEY = "weather-agent-conversations";

const API_BASE = (
  import.meta.env.VITE_API_URL ?? "http://localhost:8000"
).replace(/\/$/, "");

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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error("Request failed");
  return (await res.json()) as ChatApiResponse;
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
  const [animatingTitleIds, setAnimatingTitleIds] = useState<Set<string>>(
    () => new Set(),
  );
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
        } catch {
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
    } catch {
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
            <div className="chat-header-icon">W</div>
            <span className="chat-header-title">
              {activeConversation?.title ?? "Weather Agent"}
            </span>
          </header>

          <div className="chat-messages" ref={messagesContainerRef}>
            {isEmpty ? (
              <div className="chat-empty">
                <div className="chat-empty-icon">W</div>
                <h2>How can I help you today?</h2>
                <p>Ask about the weather or your location.</p>
                <div className="chat-suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="chat-suggestion"
                      onClick={() => sendMessage(suggestion)}
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
                      {msg.role === "user" ? "Y" : "W"}
                    </div>
                    <div className="message-body">
                      <div className="message-label">
                        {msg.role === "user" ? "You" : "Weather Agent"}
                      </div>
                      {msg.content}
                    </div>
                  </article>
                ))}
                {loading && (
                  <article className="message">
                    <div className="message-avatar assistant">W</div>
                    <div className="message-body">
                      <div className="message-label">Weather Agent</div>
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
                  placeholder="Message Weather Agent..."
                  rows={1}
                  disabled={loading}
                />
                <button
                  type="submit"
                  className="chat-send"
                  disabled={loading || !input.trim()}
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
            <p className="chat-footer-note">
              Weather Agent can make mistakes. Check important info.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
