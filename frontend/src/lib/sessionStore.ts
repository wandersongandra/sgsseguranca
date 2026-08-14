export type Session = {
  userId: string;
  user?: {
    id: string;
    companyId?: string | null;
    profileName?: string | null;
    isAdminGeral: boolean;
  };
  companyId?: string | null;
  profileName?: string | null;
  roles?: string[];
  /** Identificador efêmero da sessão/contexto de autenticação atual. */
  generation?: string;
};

type SessionListener = (session: Session | null) => void;

let session: Session | null = null;
let generation = createGeneration();
const listeners = new Set<SessionListener>();

function createGeneration(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const sessionStore = {
  get(): Session | null {
    return session;
  },

  set(next: Session) {
    session = { ...next, generation: next.generation || generation };
    for (const listener of listeners) listener(session);
  },

  rotateGeneration() {
    generation = createGeneration();
    if (session) session = { ...session, generation };
    for (const listener of listeners) listener(session);
    return generation;
  },

  getGeneration() {
    return generation;
  },

  clear() {
    generation = createGeneration();
    session = null;
    for (const listener of listeners) listener(session);
  },

  subscribe(listener: SessionListener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
