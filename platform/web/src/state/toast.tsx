import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

interface Toast {
  id: number
  text: string
}

const ToastContext = createContext<(text: string) => void>(() => {})

/** Short messages for things that happen away from where the person is looking (failed sign-in, failed cancel). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), [])
  const show = useCallback(
    (text: string) => {
      const id = nextId.current++
      setToasts((list) => [...list.slice(-2), { id, text }])
      window.setTimeout(() => dismiss(id), 6000)
    },
    [dismiss],
  )

  const value = useMemo(() => show, [show])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            <span>{toast.text}</span>
            <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): (text: string) => void {
  return useContext(ToastContext)
}
