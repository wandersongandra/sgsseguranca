'use client';
import { logger } from '@/lib/logger';

import { useState, useRef, useEffect } from 'react';
import Image from 'next/image';
import { PenTool, Upload, Camera, Check, RefreshCw, ShieldCheck } from 'lucide-react';
import SignatureCanvas from 'react-signature-canvas';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  ModalBody,
  ModalFooter,
  ModalFrame,
  ModalHeader,
} from '@/components/ui/modal-frame';
import { readThemeVar } from '@/lib/theme/read-theme-var';
import { signaturesService } from '@/services/signaturesService';

interface SignatureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (signatureData: string, type: string) => void;
  userName: string;
}

export function SignatureModal({ isOpen, onClose, onSave, userName }: SignatureModalProps) {
  const [activeTab, setActiveTab] = useState<'digital' | 'upload' | 'facial' | 'hmac'>('hmac');
const timerRef = useRef<number | undefined>(undefined);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [newPin, setNewPin] = useState('');
  const [settingPin, setSettingPin] = useState(false);
  const [pinPassword, setPinPassword] = useState('');
  const signatureInk = readThemeVar('--ds-accent-primary', 'CanvasText');

  const sigCanvas = useRef<SignatureCanvas>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tabButtonClassName =
    'flex flex-1 items-center justify-center space-x-2 rounded-[var(--ds-radius-md)] py-2 text-sm font-medium motion-safe:transition-all focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]';

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      logger.error('Erro ao acessar a câmera:', err);
      toast.error('Não foi possível acessar a câmera.');
      // Usar um pequeno delay para evitar renderização em cascata se chamado do useEffect
      setTimeout(() => setActiveTab('digital'), 0);
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => {

    const timer = timerRef.current;


    return () => {

      if (timer) {

        clearTimeout(timer);

      }

    };

  }, []);

useEffect(() => {
    if (activeTab === 'facial' && isOpen) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [activeTab, isOpen]);

  useEffect(() => {
    if (activeTab === 'hmac' && isOpen && hasPin === null) {
      signaturesService.getSignaturePinStatus()
        .then((r) => setHasPin(r.has_pin))
        .catch(() => {
          setHasPin(false);
          toast.error('Não foi possível verificar o status do PIN.');
        });
    }
  }, [activeTab, isOpen, hasPin]);

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png');
        setPreviewImage(dataUrl);
        stopCamera();
      }
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreviewImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const clearSignature = () => {
    if (activeTab === 'digital') {
      sigCanvas.current?.clear();
    } else if (activeTab === 'hmac') {
      setPin('');
    } else {
      setPreviewImage(null);
      if (activeTab === 'facial') startCamera();
    }
  };

  const getDigitalSignatureDataUrl = () => {
    const canvasHandle = sigCanvas.current;
    if (!canvasHandle) return '';

    // Tentar obter o canvas recortado (sem espaços em branco)
    try {
      if (canvasHandle && typeof canvasHandle.getTrimmedCanvas === 'function') {
        const trimmedCanvas = canvasHandle.getTrimmedCanvas();
        if (trimmedCanvas && typeof trimmedCanvas.toDataURL === 'function') {
          return trimmedCanvas.toDataURL('image/png');
        }
      }
    } catch (error) {
      // Logar como aviso para não poluir o console de erro se o fallback funcionar
      logger.warn('Falha ao recortar assinatura (getTrimmedCanvas), usando fallback:', error);
    }

    // Fallback 1: Canvas bruto da biblioteca
    try {
      if (canvasHandle && typeof canvasHandle.toDataURL === 'function') {
        return canvasHandle.toDataURL('image/png');
      }
    } catch (error) {
      logger.error('Falha ao gerar assinatura via toDataURL:', error);
    }

    // Fallback 2: Canvas nativo subjacente
    try {
      const rawCanvas =
        canvasHandle && typeof canvasHandle.getCanvas === 'function' ? canvasHandle.getCanvas() : null;
      if (rawCanvas && typeof rawCanvas.toDataURL === 'function') {
        return rawCanvas.toDataURL('image/png');
      }
    } catch (error) {
      logger.error('Falha crítica ao acessar canvas nativo:', error);
    }

    return '';
  };

  const handleSavePin = async () => {
    if (!/^\d{4,6}$/.test(newPin)) {
      toast.error('PIN deve ter 4 a 6 dígitos numéricos.');
      return;
    }
    setSettingPin(true);
    try {
      await signaturesService.setSignaturePin(newPin, pinPassword || undefined);
      setHasPin(true);
      setNewPin('');
      setPinPassword('');
      toast.success('PIN de assinatura configurado!');
    } catch {
      toast.error('Erro ao configurar PIN. Verifique sua senha.');
    } finally {
      setSettingPin(false);
    }
  };

  const handleSave = () => {
    let signatureData = '';
    // A aba é rótulo de UI; o `type` enviado precisa ser um dos tipos
    // canônicos aceitos pelo backend (só `hmac` é prova verificada — os
    // demais são captura de evidência e são rotulados como tal no PDF).
    let signatureType: 'hmac' | 'drawn' | 'upload' = 'drawn';

    if (activeTab === 'digital') {
      if (sigCanvas.current?.isEmpty()) {
        toast.error('Por favor, faça a assinatura.');
        return;
      }
      signatureData = getDigitalSignatureDataUrl();
      if (!signatureData) {
        toast.error('Não foi possível capturar a assinatura. Tente novamente.');
        return;
      }
      signatureType = 'drawn';
    } else if (activeTab === 'hmac') {
      if (!/^\d{4,6}$/.test(pin)) {
        toast.error('Digite um PIN válido (4 a 6 dígitos).');
        return;
      }
      // Passa o PIN junto com tipo 'hmac'; o backend computa o HMAC
      onSave(pin, 'hmac');
      setPin('');
      onClose();
      return;
    } else {
      if (!previewImage) {
        toast.error('Por favor, forneça a imagem da assinatura.');
        return;
      }
      signatureData = previewImage;
      // 'upload' e 'facial' são ambos imagem enviada/capturada pelo cliente.
      signatureType = 'upload';
    }

    onSave(signatureData, signatureType);
    onClose();
  };

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} shellClassName="max-w-lg" overlayClassName="z-[60]">
        <ModalHeader
          title="Assinatura de participante"
          description={`Participante: ${userName}`}
          icon={<PenTool className="h-5 w-5" />}
          onClose={onClose}
        />

        <ModalBody>
          <div className="mb-6 flex space-x-2 rounded-[var(--ds-radius-lg)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-muted)]/35 p-1">
            <button
              type="button"
              onClick={() => setActiveTab('digital')}
              className={`${tabButtonClassName} ${
                activeTab === 'digital'
                  ? 'border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-primary)] shadow-[var(--ds-shadow-xs)]'
                  : 'text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]'
              }`}
            >
              <PenTool className="h-4 w-4" />
              <span>Digital</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('upload')}
              className={`${tabButtonClassName} ${
                activeTab === 'upload'
                  ? 'border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-primary)] shadow-[var(--ds-shadow-xs)]'
                  : 'text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]'
              }`}
            >
              <Upload className="h-4 w-4" />
              <span>Upload</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('facial')}
              className={`${tabButtonClassName} ${
                activeTab === 'facial'
                  ? 'border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-primary)] shadow-[var(--ds-shadow-xs)]'
                  : 'text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]'
              }`}
            >
              <Camera className="h-4 w-4" />
              <span>Facial</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('hmac')}
              className={`${tabButtonClassName} ${
                activeTab === 'hmac'
                  ? 'border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] text-[var(--ds-color-text-primary)] shadow-[var(--ds-shadow-xs)]'
                  : 'text-[var(--ds-color-text-secondary)] hover:text-[var(--ds-color-text-primary)]'
              }`}
            >
              <ShieldCheck className="h-4 w-4" />
              <span>PIN</span>
            </button>
          </div>

          <div
            className="relative mb-6 flex h-64 w-full items-center justify-center overflow-hidden rounded-[var(--ds-radius-xl)] border-2 border-dashed border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-muted)]/26"
          >
            {activeTab === 'digital' && (
              <SignatureCanvas
                ref={sigCanvas}
                penColor={signatureInk}
                canvasProps={{
                  className: "h-full w-full cursor-crosshair",
                }}
              />
            )}

            {activeTab === 'upload' && (
              <div className="flex flex-col items-center justify-center p-4">
                {previewImage ? (
                  <div className="relative h-56 w-full">
                    <Image
                      src={previewImage}
                      alt="Preview"
                      fill
                      sizes="(min-width: 640px) 480px, 100vw"
                      className="rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-subtle)] bg-[var(--ds-color-surface-base)] object-contain p-2"
                    />
                  </div>
                ) : (
                  <label className="flex cursor-pointer flex-col items-center justify-center space-y-2">
                    <div className="rounded-full bg-[var(--ds-color-primary-subtle)] p-3">
                      <Upload className="h-6 w-6 text-[var(--ds-color-action-primary)]" />
                    </div>
                    <span className="text-sm font-medium text-[var(--ds-color-text-secondary)]">Clique para selecionar imagem</span>
                    <span className="text-xs text-[var(--ds-color-text-muted)]">PNG, JPG ou JPEG</span>
                    <input
                      type="file"
                      className="hidden"
                      accept="image/*"
                      aria-label="Selecionar imagem de assinatura"
                      onChange={handleFileUpload}
                    />
                  </label>
                )}
              </div>
            )}

            {activeTab === 'facial' && (
              <div className="relative h-full w-full">
                {previewImage ? (
                  <Image
                    src={previewImage}
                    alt="Foto Capturada"
                    fill
                    sizes="(min-width: 640px) 480px, 100vw"
                    className="object-cover"
                  />
                ) : (
                  <>
                    <video ref={videoRef} autoPlay playsInline className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={capturePhoto}
                      className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-[var(--ds-color-action-primary)] p-4 text-[var(--ds-color-action-primary-foreground)] shadow-[var(--ds-shadow-sm)] motion-safe:transition-transform hover:bg-[var(--ds-color-action-primary-hover)] active:scale-95"
                      title="Capturar Foto"
                    >
                      <Camera className="h-6 w-6" />
                    </button>
                  </>
                )}
                <canvas ref={canvasRef} className="hidden" />
              </div>
            )}

            {activeTab === 'hmac' && (
              <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6">
                {hasPin === null && (
                  <p className="text-sm text-[var(--ds-color-text-muted)]">Verificando PIN…</p>
                )}

                {hasPin === false && (
                  <div className="flex w-full flex-col gap-3">
                    <p className="text-center text-sm font-medium text-[var(--ds-color-text-secondary)]">
                      Configure seu PIN de assinatura (4–6 dígitos)
                    </p>
                    <input
                      type="password"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="Novo PIN (4–6 dígitos)"
                      value={newPin}
                      onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
                      className="w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-center text-lg tracking-widest focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]"
                    />
                    <input
                      type="password"
                      placeholder="Senha de acesso (confirmação)"
                      value={pinPassword}
                      onChange={(e) => setPinPassword(e.target.value)}
                      className="w-full rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]"
                    />
                    <Button type="button" onClick={handleSavePin} disabled={settingPin}>
                      {settingPin ? 'Salvando…' : 'Salvar PIN'}
                    </Button>
                  </div>
                )}

                {hasPin === true && (
                  <div className="flex w-full flex-col items-center gap-3">
                    <ShieldCheck className="h-10 w-10 text-[var(--ds-color-action-primary)]" />
                    <p className="text-sm font-medium text-[var(--ds-color-text-secondary)]">
                      Digite seu PIN para assinar
                    </p>
                    <input
                      type="password"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="PIN (4–6 dígitos)"
                      value={pin}
                      onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                      className="w-full max-w-xs rounded-[var(--ds-radius-md)] border border-[var(--ds-color-border-default)] bg-[var(--ds-color-surface-base)] px-3 py-2 text-center text-2xl tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-[var(--ds-color-focus-ring)]"
                    />
                    <p className="text-xs text-[var(--ds-color-text-muted)]">
                      Assinatura HMAC-SHA256 verificada pelo servidor
                    </p>
                  </div>
                )}
              </div>
            )}

          </div>
        </ModalBody>

        <ModalFooter className="items-center justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={clearSignature}
            leftIcon={<RefreshCw className="h-4 w-4" />}
          >
            Limpar
          </Button>
          <div className="flex space-x-3">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              leftIcon={<Check className="h-4 w-4" />}
            >
              Confirmar assinatura
            </Button>
          </div>
        </ModalFooter>
    </ModalFrame>
  );
}
