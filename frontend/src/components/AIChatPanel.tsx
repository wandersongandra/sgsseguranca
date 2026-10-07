'use client';

import { useState, useRef, useEffect, type ChangeEvent } from 'react';
import { Send, X, Loader2, Sparkles, ImagePlus, TriangleAlert } from 'lucide-react';
import Image from 'next/image';
import { aiService } from '@/services/aiService';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';
import type { AiRouteContext } from '@/lib/ai-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface AIChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  context: AiRouteContext;
}

export function AIChatPanel({ isOpen, onClose, context }: AIChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>(() => [
    {
      role: 'assistant',
      content: context.assistantIntro,
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [selectedImagePreview, setSelectedImagePreview] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMessages([
      {
        role: 'assistant',
        content: context.assistantIntro,
        timestamp: new Date(),
      },
    ]);
  }, [context.assistantIntro]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (!selectedImage) {
      setSelectedImagePreview(null);
      return;
    }

    const objectUrl = URL.createObjectURL(selectedImage);
    setSelectedImagePreview(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [selectedImage]);

  const formatImageAnalysis = (analysis: Awaited<ReturnType<typeof aiService.analyzeImageRisk>>) =>
    [
      `Resumo: ${analysis.summary}`,
      `Nível de risco: ${analysis.riskLevel}`,
      analysis.imminentRisks.length
        ? `Riscos iminentes:\n- ${analysis.imminentRisks.join('\n- ')}`
        : null,
      analysis.immediateActions.length
        ? `Ações imediatas:\n- ${analysis.immediateActions.join('\n- ')}`
        : null,
      analysis.ppeRecommendations.length
        ? `EPIs recomendados:\n- ${analysis.ppeRecommendations.join('\n- ')}`
        : null,
      `Observações: ${analysis.notes}`,
    ]
      .filter(Boolean)
      .join('\n\n');

  const clearSelectedImage = () => {
    setSelectedImage(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const getFriendlyErrorMessage = (error: unknown) => {
    const maybeAxios = error as { response?: { status?: number }; code?: string; message?: string };
    const status = maybeAxios?.response?.status;
    const code = maybeAxios?.code;
    const message = String(maybeAxios?.message || '').toLowerCase();

    if (status === 401) {
      return 'Sua sessão expirou ou o refresh token não está disponível. Entre novamente para continuar usando a SOPHIE.';
    }

    if (status === 403) {
      return 'Seu perfil não possui permissão para usar a SOPHIE neste ambiente.';
    }

    if (status === 404) {
      return 'A SOPHIE está desativada neste ambiente no momento.';
    }

    if (status === 429) {
      return 'A SOPHIE atingiu o limite temporario de uso. Tente novamente em instantes.';
    }

    if (code === 'ECONNABORTED' || message.includes('timeout')) {
      return 'A SOPHIE está demorando mais do que o esperado para responder. Aguarde alguns segundos e tente novamente.';
    }

    return 'Não consegui responder agora. Tente novamente em instantes.';
  };

  const handleSelectImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      return;
    }

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'Use uma imagem JPG, PNG ou WEBP para análise de risco.',
          timestamp: new Date(),
        },
      ]);
      clearSelectedImage();
      return;
    }

    setSelectedImage(file);
  };

  const handleSend = async () => {
    if ((!input.trim() && !selectedImage) || isLoading) return;

    const prompt = input.trim() || 'Analise os riscos visíveis nesta imagem.';
    const contextualPrompt = `${context.promptPrefix}\n\nSolicitação do usuário: ${prompt}`;

    const userMessage: Message = {
      role: 'user',
      content: selectedImage
        ? `${prompt}\n\n[Imagem anexada: ${selectedImage.name}]`
        : prompt,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const conversationHistory = messages.slice(-10).map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      const assistantContent = selectedImage
        ? formatImageAnalysis(await aiService.analyzeImageRisk(selectedImage, contextualPrompt))
        : (
            await aiService.chat(contextualPrompt, {
              conversationHistory,
            })
          ).answer;

      const assistantMessage: Message = {
        role: 'assistant',
        content: assistantContent,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      logger.error('Erro no chat da SOPHIE:', error);
      const errorMessage: Message = {
        role: 'assistant',
        content: getFriendlyErrorMessage(error),
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      clearSelectedImage();
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  const ContextIcon = context.icon;

  return (
    <div
      id="sophie-chat-panel"
      role="dialog"
      aria-modal="false"
      aria-label="Painel do chat da SOPHIE"
      className="fixed bottom-[calc(var(--ds-mobile-nav-total-height)+0.5rem)] left-[max(0.75rem,var(--ds-safe-area-left))] right-[max(0.75rem,var(--ds-safe-area-right))] z-50 flex h-[min(40rem,calc(100dvh-var(--ds-mobile-nav-total-height)-5rem))] flex-col overflow-hidden rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-strong)] bg-[var(--component-chat-shell-bg)] shadow-[var(--ds-shadow-sm)] animate-fade-in sm:bottom-24 sm:left-auto sm:right-6 sm:w-[430px]"
    >
      <div className="flex items-center justify-between border-b border-[var(--ds-color-border-strong)] bg-[var(--component-chat-header-bg)] px-4 py-3 text-[var(--ds-color-action-primary-foreground)]">
        <div className="flex min-w-0 items-center space-x-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-[var(--ds-radius-md)] border border-[var(--ds-color-primary-border)] bg-[color:var(--ds-color-surface-base)]/12 text-[var(--ds-color-action-primary-foreground)]">
            <ContextIcon className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold">{context.title}</h3>
            <div className="flex items-center space-x-1">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--ds-color-accent)] animate-pulse"></span>
              <span className="truncate text-[10px] text-[color:var(--ds-color-action-primary-foreground)]/88">{context.subtitle}</span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--ds-radius-md)] transition-colors hover:bg-[color:var(--ds-color-surface-base)]/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-color-action-primary-foreground)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--component-chat-header-bg)]"
          title="Fechar chat"
          aria-label="Fechar chat"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 space-y-4 overflow-y-auto bg-[color:var(--ds-color-surface-muted)]/18 p-4">
        <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-base)] p-3 text-xs text-[var(--ds-color-text-secondary)] shadow-[var(--ds-shadow-xs)]">
          <p className="font-semibold text-[var(--ds-color-text-primary)]">
            Chat da SOPHIE
          </p>
          <p className="mt-1 leading-relaxed">
            Pergunte sobre a tela atual, peça apoio para um documento ou envie uma foto para análise de risco.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {context.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => setInput(suggestion)}
              className="min-h-11 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-base)]/92 px-3 py-2 text-left text-xs font-medium text-[var(--ds-color-text-secondary)] transition-colors hover:border-[var(--ds-color-border-default)] hover:bg-[var(--ds-color-surface-muted)] hover:text-[var(--ds-color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-color-surface-muted)]"
            >
              {suggestion}
            </button>
          ))}
        </div>
        {messages.map((message, index) => (
          <div
            key={index}
            className={cn(
              "flex w-full",
              message.role === 'user' ? "justify-end" : "justify-start"
            )}
          >
            <div
              className={cn(
                "max-w-[88%] rounded-[var(--ds-radius-md)] px-3.5 py-2 text-sm sm:max-w-[80%] sm:px-4",
                message.role === 'user'
                  ? "bg-[var(--component-chat-user-bubble-bg)] text-[var(--component-chat-user-bubble-text)]"
                  : "border border-[var(--ds-color-border-subtle)] bg-[var(--component-chat-assistant-bubble-bg)] text-[var(--ds-color-text-primary)]"
              )}
            >
              {message.content}
              <div
                className={cn(
                  "mt-1 text-[10px]",
                  message.role === 'user' ? "text-white/82" : "text-[var(--ds-color-text-muted)]"
                )}
              >
                {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="flex items-center space-x-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] px-4 py-2">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--ds-color-action-primary)]" />
              <span className="text-xs italic text-[var(--ds-color-text-muted)]">SOPHIE analisando...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-base)]/95 p-3 pb-[max(0.75rem,var(--ds-safe-area-bottom))] sm:p-4">
        {selectedImagePreview ? (
          <div className="mb-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[color:var(--ds-color-surface-muted)]/32 p-3">
            <div className="mb-2 flex items-center justify-between">
              <Badge variant="warning" className="text-[11px]">
                <TriangleAlert className="h-3.5 w-3.5" />
                Foto pronta para análise de risco
              </Badge>
              <button
                type="button"
                onClick={clearSelectedImage}
                className="flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-sm)] text-[var(--ds-color-text-muted)] transition-colors hover:bg-[var(--ds-color-surface-muted)] hover:text-[var(--ds-color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-color-surface-muted)]"
                title="Remover imagem"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <Image
              src={selectedImagePreview}
              alt="Pré-visualização da imagem enviada para a SOPHIE"
              width={640}
              height={224}
              className="h-28 w-full rounded-[var(--ds-radius-sm)] object-cover"
              unoptimized
            />
          </div>
        ) : null}
        <div className="relative flex items-center">
          <input
            ref={fileInputRef}
            type="file"
            aria-label="Selecionar imagem para análise de risco"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleSelectImage}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            className="absolute left-0.5 flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-sm)] text-[var(--ds-color-text-muted)] transition-colors hover:bg-[var(--ds-color-surface-muted)] hover:text-[var(--ds-color-action-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-color-surface-base)] disabled:border-transparent disabled:bg-transparent disabled:text-[var(--disabled-text)]"
            title="Anexar foto para análise"
            aria-label="Anexar foto para análise"
          >
            <ImagePlus className="h-4 w-4" />
          </button>
          <Input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="Pergunte sobre a tela atual..."
            className="min-h-11 rounded-[var(--ds-radius-md)] bg-[color:var(--ds-color-surface-muted)]/26 py-2 pl-12 pr-12"
          />
          <Button
            onClick={handleSend}
            disabled={(!input.trim() && !selectedImage) || isLoading}
            size="icon"
            className="absolute right-0.5 h-11 w-11 rounded-[var(--ds-radius-sm)]"
            title="Enviar mensagem"
            aria-label="Enviar mensagem"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-2 flex items-center justify-center space-x-1">
          <Sparkles className="h-3 w-3 text-[var(--ds-color-accent)]" />
          <span className="text-center text-[10px] leading-4 text-[var(--ds-color-text-muted)]">
            SOPHIE usa o contexto da tela atual e pode analisar imagens enviadas por você
          </span>
        </div>
      </div>
    </div>
  );
}
