"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";

const CONFIG_KEY = "career-ops:config";

export function PromptBar() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<string | null>(null);
  const [cliId, setCliId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    function read() {
      try {
        const raw = localStorage.getItem(CONFIG_KEY);
        setCliId(raw ? JSON.parse(raw).cliId || null : null);
      } catch {
        setCliId(null);
      }
    }
    read();
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || busy || !cliId) return;
    setInput("");
    setResponse(null);
    setBusy(true);

    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, cliId, history: [], pageContext: "Prompt bar - quick command" }),
      });

      if (!res.ok || !res.body) {
        setResponse("⚠️ Error connecting to assistant");
        setBusy(false);
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        const clean = acc.replace(/<<act:[^>]+>>/g, "").trim();
        setResponse(clean.slice(0, 200) + (clean.length > 200 ? "..." : ""));
      }

      setTimeout(() => setResponse(null), 8000);
    } catch {
      setResponse("⚠️ Connection error");
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    if (e.key === "Escape") {
      setInput("");
      inputRef.current?.blur();
    }
  }

  return (
    <div className="sticky top-0 z-40 border-b border-border bg-surface/80 backdrop-blur-sm">
      <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-2">
        <Sparkles className="size-4 shrink-0 text-brand" />
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={cliId ? "Ask anything or give a command..." : "Configure CLI in settings first"}
          disabled={!cliId}
          className={cn(
            "flex-1 bg-transparent text-sm outline-none placeholder:text-faint",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
        />
        <button
          onClick={send}
          disabled={busy || !input.trim() || !cliId}
          className="rounded-lg bg-brand p-1.5 text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-40"
          aria-label="Send"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </button>
      </div>

      {response && (
        <div className="border-t border-border/50 bg-surface-hover/50 px-4 py-2">
          <p className="mx-auto max-w-4xl text-xs text-muted">{response}</p>
        </div>
      )}
    </div>
  );
}
