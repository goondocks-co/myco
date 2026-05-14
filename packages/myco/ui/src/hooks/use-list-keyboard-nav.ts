import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

export interface UseListKeyboardNavOptions<T> {
  items: T[];
  getId: (item: T) => string;
  selectedId?: string;
  onActivate: (id: string) => void;
  filterInputRef?: RefObject<HTMLInputElement | null>;
  enabled?: boolean;
}

export interface UseListKeyboardNavResult {
  cursorIndex: number;
  setRowRef: (idx: number) => (el: HTMLElement | null) => void;
  containerProps: {
    tabIndex: 0;
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  };
}

function hasNoModifier(e: KeyboardEvent<HTMLDivElement>): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

export function useListKeyboardNav<T>({
  items,
  getId,
  selectedId,
  onActivate,
  filterInputRef,
  enabled = true,
}: UseListKeyboardNavOptions<T>): UseListKeyboardNavResult {
  const getIdRef = useRef(getId);
  getIdRef.current = getId;

  const [cursorIndex, setCursorIndex] = useState(() => {
    if (!selectedId) return 0;
    const idx = items.findIndex((it) => getId(it) === selectedId);
    return idx >= 0 ? idx : 0;
  });
  const rowRefs = useRef<Array<HTMLElement | null>>([]);
  const lastSyncedSelectedId = useRef<string | undefined>(selectedId);

  useEffect(() => {
    if (lastSyncedSelectedId.current === selectedId) return;
    lastSyncedSelectedId.current = selectedId;
    if (!selectedId) return;
    const idx = items.findIndex((it) => getIdRef.current(it) === selectedId);
    if (idx >= 0) setCursorIndex(idx);
  }, [selectedId, items]);

  useEffect(() => {
    if (cursorIndex >= items.length) {
      setCursorIndex(Math.max(0, items.length - 1));
    }
    if (rowRefs.current.length > items.length) {
      rowRefs.current.length = items.length;
    }
  }, [items.length, cursorIndex]);

  useEffect(() => {
    const el = rowRefs.current[cursorIndex];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [cursorIndex]);

  const setRowRef = useCallback(
    (idx: number) => (el: HTMLElement | null) => {
      rowRefs.current[idx] = el;
    },
    [],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!enabled) return;
      if (e.key === '/' && hasNoModifier(e) && filterInputRef?.current) {
        e.preventDefault();
        filterInputRef.current.focus();
        return;
      }
      if (!hasNoModifier(e)) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setCursorIndex((c) => Math.min(items.length - 1, c + 1));
        return;
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursorIndex((c) => Math.max(0, c - 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const it = items[cursorIndex];
        if (it) onActivate(getId(it));
      }
    },
    [enabled, items, cursorIndex, onActivate, getId, filterInputRef],
  );

  return {
    cursorIndex,
    setRowRef,
    containerProps: { tabIndex: 0, onKeyDown },
  };
}
